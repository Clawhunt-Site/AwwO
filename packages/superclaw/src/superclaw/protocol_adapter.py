from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any

from superclaw.models import ArtifactRef, ChildExecution, EvidenceBundle, VerificationFinding, WorkerResult
from superclaw.secrets_scan import contains_secret


DEFAULT_ADAPTER_NAME = "clawhunt.v1.solution"
DELIVERY_PROTOCOL_ADAPTER_NAME = "clawhunt.delivery_protocol.v1"


def default_solution_text(run_id: str) -> str:
    return (
        f"SuperClaw completed run {run_id} with command-backed worker evidence, "
        "adversarial verification findings, artifact references, and a normalized evidence bundle."
    )


def _json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str))


def _evidence_snapshot(bundle: EvidenceBundle | dict[str, Any] | None) -> dict[str, Any] | None:
    if bundle is None:
        return None
    if isinstance(bundle, dict):
        return _json_clone(bundle)
    snapshot = EvidenceBundle(
        run_id=bundle.run_id,
        probes=_json_clone(bundle.probes),
        commands=_json_clone(bundle.commands),
        worker_results=[WorkerResult(**_json_clone(asdict(item))) for item in bundle.worker_results],
        artifacts=[ArtifactRef(**_json_clone(asdict(item))) for item in bundle.artifacts],
        child_executions=[ChildExecution(**_json_clone(asdict(item))) for item in bundle.child_executions],
        findings=[VerificationFinding(**_json_clone(asdict(item))) for item in bundle.findings],
        submitted_to_clawhunt=bundle.submitted_to_clawhunt,
        submission_response=_json_clone(bundle.submission_response),
        backend_summary=_json_clone(bundle.backend_summary),
    )
    return snapshot.to_dict()


def _evidence_summary(evidence: dict[str, Any] | None) -> dict[str, Any]:
    evidence = evidence or {}
    return {
        "run_id": evidence.get("run_id"),
        "command_count": len(evidence.get("commands", [])),
        "probe_count": len(evidence.get("probes", [])),
        "artifact_count": len(evidence.get("artifacts", [])),
        "child_execution_count": len(evidence.get("child_executions", [])),
        "finding_count": len(evidence.get("findings", [])),
        "worker_result_count": len(evidence.get("worker_results", [])),
        "chain_verdict": evidence.get("chain_verdict"),
    }


def _policy_decision_code(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return text.split(":", 1)[0].strip() or None


def _plugin_invocation_summaries(evidence: dict[str, Any] | None) -> list[dict[str, Any]]:
    evidence = evidence or {}
    summaries_by_key: dict[str, dict[str, Any]] = {}
    ordered_keys: list[str] = []

    def append_summary(summary: dict[str, Any]) -> None:
        sanitized = {key: value for key, value in summary.items() if value not in (None, "", [])}
        entitlement_id = sanitized.get("entitlement_id")
        if entitlement_id and contains_secret(str(entitlement_id)):
            sanitized.pop("entitlement_id", None)
        key = str(sanitized.get("evidence_artifact_id") or json.dumps(sanitized, ensure_ascii=False, sort_keys=True, default=str))
        if not sanitized:
            return
        existing = summaries_by_key.get(key)
        if existing is None:
            summaries_by_key[key] = sanitized
            ordered_keys.append(key)
            return
        if len(sanitized) > len(existing):
            summaries_by_key[key] = sanitized

    for probe in evidence.get("probes", []):
        if probe.get("name") != "plugin_invocation":
            continue
        body = probe.get("body")
        if not isinstance(body, dict):
            continue
        append_summary(
            {
                "plugin_id": body.get("plugin_id"),
                "plugin_version": body.get("plugin_version"),
                "package_digest": body.get("package_digest"),
                "tool_name": body.get("tool_name"),
                "status": body.get("status"),
                "started_at": body.get("started_at"),
                "finished_at": body.get("finished_at"),
                "entitlement_id": body.get("entitlement_id"),
                "input_digest": body.get("input_digest"),
                "output_digest": body.get("output_digest"),
                "evidence_artifact_id": body.get("evidence_artifact_id"),
                "policy_decision_code": _policy_decision_code(body.get("policy_decision")),
                "sandbox_exit_status": body.get("sandbox_exit_status"),
            }
        )

    for artifact in evidence.get("artifacts", []):
        if artifact.get("kind") != "plugin-invocation":
            continue
        metadata = artifact.get("metadata") if isinstance(artifact.get("metadata"), dict) else {}
        append_summary(
            {
                "plugin_id": metadata.get("plugin_id"),
                "tool_name": metadata.get("tool_name"),
                "status": metadata.get("status"),
                "evidence_artifact_id": artifact.get("artifact_id"),
            }
        )

    return [summaries_by_key[key] for key in ordered_keys]


def _child_execution_summaries(evidence: dict[str, Any] | None) -> list[dict[str, Any]]:
    evidence = evidence or {}
    summaries: list[dict[str, Any]] = []
    for child in evidence.get("child_executions", []):
        if not isinstance(child, dict):
            continue
        summary = {
            "child_task_id": child.get("child_task_id"),
            "child_run_id": child.get("child_run_id"),
            "parent_task_id": child.get("parent_task_id"),
            "backend": child.get("backend"),
            "status": child.get("status"),
            "depth": child.get("depth"),
            "cancellation_mode": child.get("cancellation_mode"),
            "timeout_seconds": child.get("timeout_seconds"),
            "evidence_owner": child.get("evidence_owner"),
            "chain_verdict": child.get("chain_verdict"),
            "evidence_artifact_id": child.get("evidence_artifact_id"),
        }
        summaries.append({key: value for key, value in summary.items() if value not in (None, "", [])})
    return summaries


def _truncate(value: Any, *, limit: int = 240) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _infer_runtime_language(evidence: dict[str, Any] | None) -> str:
    evidence = evidence or {}
    commands = [str(item.get("command") or "").lower() for item in evidence.get("commands", [])]
    if any(command.startswith("python") or "python " in command for command in commands):
        return "python"
    if any(command.startswith("node") or "npm " in command or "pnpm " in command or "yarn " in command for command in commands):
        return "node"
    worker_backends = {str(item.get("backend") or "").lower() for item in evidence.get("worker_results", [])}
    if "local" in worker_backends:
        return "other"
    return "other"


def _default_manifest_level(evidence: dict[str, Any] | None) -> str:
    summary = _evidence_summary(evidence)
    if summary["worker_result_count"] and summary["artifact_count"] and summary["probe_count"]:
        return "L2"
    if summary["worker_result_count"] or summary["command_count"]:
        return "L1"
    return "L0"


_MANIFEST_FINDING_SEVERITIES = frozenset({"info", "warning", "high", "critical"})


def build_clawhunt_delivery_protocol_manifest(
    *,
    name: str,
    summary: str,
    evidence: EvidenceBundle | dict[str, Any] | None = None,
    version: str = "0.1.0",
    interface_type: str = "workflow",
    level: str | None = None,
    tags: list[str] | None = None,
    limitations: list[str] | None = None,
    certified_for_standard_delivery: bool = False,
) -> dict[str, Any]:
    evidence_payload = _evidence_snapshot(evidence) or {}
    evidence_summary = _evidence_summary(evidence_payload)
    probes = list(evidence_payload.get("probes", []))
    commands = list(evidence_payload.get("commands", []))
    artifacts = list(evidence_payload.get("artifacts", []))
    findings = list(evidence_payload.get("findings", []))
    worker_results = list(evidence_payload.get("worker_results", []))
    backend_summary = dict(evidence_payload.get("backend_summary", {}))
    manifest_level = level or _default_manifest_level(evidence_payload)
    plugin_invocations = _plugin_invocation_summaries(evidence_payload)
    child_executions = _child_execution_summaries(evidence_payload)

    # findings 在 manifest 里只 surface *纯数字聚合*（severity 分布 + 失败计数），刻意不
    # 暴露每条 finding 的 name/detail/remediation —— detail/remediation 是自由文本，可能
    # 含敏感验证细节，而本 manifest 会外发给 ClawHunt（fail-closed：暴露"做了多少/多严重"
    # 的信号，不泄露发现内容）。这与 artifacts 只暴露 kinds/sensitivities 的取舍一致。
    #
    # severity 一律 clamp 到固定枚举：本函数也支持 prebuilt dict evidence，那条路径的 finding
    # 不受 add_finding() 约束——malformed（非 dict）或被污染的 severity（如 "critical <secret>"）
    # 绝不能让任意文本原样成为外发 manifest 的 key（fail-closed），也绝不能让非 dict item 崩。
    findings_by_severity: dict[str, int] = {}
    failed_finding_count = 0
    for finding in findings:
        if not isinstance(finding, dict):
            # malformed finding（非 dict）：计入 unknown 桶但不读字段、不崩、不计 failed
            findings_by_severity["unknown"] = findings_by_severity.get("unknown", 0) + 1
            continue
        severity = str(finding.get("severity") or "info")
        if severity not in _MANIFEST_FINDING_SEVERITIES:
            severity = "unknown"  # 未知/被污染的 severity 归 unknown，绝不原样外发
        findings_by_severity[severity] = findings_by_severity.get(severity, 0) + 1
        if finding.get("passed", True) is False:  # 只在显式 False 时计 failed，不用 truthiness
            failed_finding_count += 1

    runtime_environment = {
        "backend_policy": backend_summary.get("permission_policy", {}).get("mode") if isinstance(backend_summary.get("permission_policy"), dict) else None,
        "worker_backends": sorted({str(item.get("backend") or "") for item in worker_results if item.get("backend")}),
        "artifact_sensitivities": sorted({str(item.get("sensitivity") or "internal") for item in artifacts}),
    }
    runtime_environment = {key: value for key, value in runtime_environment.items() if value not in (None, [], "")}

    example_probes = [probe for probe in probes if probe.get("name") != "plugin_invocation"]

    manifest: dict[str, Any] = {
        "name": name,
        "version": version,
        "summary": summary,
        "interface": {
            "type": interface_type,
            "inputs": {
                "run_id": evidence_summary.get("run_id"),
                "probe_names": [probe.get("name") for probe in probes],
                "artifact_kinds": [artifact.get("kind") for artifact in artifacts],
            },
            "outputs": {
                "chain_verdict": evidence_summary.get("chain_verdict"),
                "worker_roles": sorted({str(item.get("role") or "") for item in worker_results if item.get("role")}),
                "child_execution_count": evidence_summary.get("child_execution_count"),
            },
        },
        "runtime": {
            "language": _infer_runtime_language(evidence_payload),
            "dependencies": sorted({str(item.get("backend") or "") for item in worker_results if item.get("backend")}),
            "environment": runtime_environment,
        },
        "acceptance": {
            "tests": [command.get("command") for command in commands if int(command.get("exit_code", 1)) == 0],
            "commands": [command.get("command") for command in commands],
            "expected_results": [
                f"chain_verdict={evidence_summary.get('chain_verdict')}",
                f"worker_results={evidence_summary.get('worker_result_count')}",
                f"artifacts={evidence_summary.get('artifact_count')}",
            ],
        },
        "standardization": {
            "level": manifest_level,
            "tags": list(tags or []),
            "limitations": list(limitations or []),
            "certified_for_standard_delivery": certified_for_standard_delivery,
        },
        "examples": [
            {
                "kind": "probe",
                "name": probe.get("name"),
                "status_code": probe.get("status_code"),
                "body_preview": _truncate(json.dumps(probe.get("body"), ensure_ascii=False, sort_keys=True)),
            }
            for probe in example_probes[:3]
        ],
        "security": {
            "artifact_sensitivities": sorted({str(item.get("sensitivity") or "internal") for item in artifacts}),
            "finding_count": evidence_summary.get("finding_count"),
            "findings_by_severity": findings_by_severity,
            "failed_finding_count": failed_finding_count,
            "plugin_package_digests": sorted(
                {
                    str(invocation.get("package_digest"))
                    for invocation in plugin_invocations
                    if invocation.get("package_digest")
                }
            ),
        },
        "observability": {
            "probe_names": [probe.get("name") for probe in probes],
            "artifact_kinds": [artifact.get("kind") for artifact in artifacts],
            "transcript_count": len([artifact for artifact in artifacts if artifact.get("kind") == "worker-transcript"]),
            "plugin_invocation_count": len(plugin_invocations),
        },
    }
    if plugin_invocations:
        manifest["plugin_evidence"] = {"invocations": plugin_invocations}
    if child_executions:
        manifest["child_evidence"] = {"executions": child_executions}
    return _json_clone(manifest)


@dataclass(frozen=True)
class ClawHuntSubmissionPayload:
    solution_text: str
    request_json: dict[str, Any]
    adapter_name: str = DEFAULT_ADAPTER_NAME
    attachments: list[str] = field(default_factory=list)
    unsupported_fields: dict[str, Any] = field(default_factory=dict)
    evidence_summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter_name": self.adapter_name,
            "request_json": _json_clone(self.request_json),
            "attachments": list(self.attachments),
            "unsupported_fields": _json_clone(self.unsupported_fields),
            "evidence_summary": _json_clone(self.evidence_summary),
        }


def build_clawhunt_submission_payload(
    *,
    solution_text: str,
    evidence: EvidenceBundle | dict[str, Any] | None = None,
    attachments: list[str] | None = None,
    package_manifest: dict[str, Any] | None = None,
    cost_tracking: dict[str, Any] | None = None,
    adapter_name: str = DEFAULT_ADAPTER_NAME,
) -> ClawHuntSubmissionPayload:
    evidence_payload = _evidence_snapshot(evidence)
    request_json: dict[str, Any] = {"solution_text": solution_text}
    normalized_attachments = list(attachments or [])
    if normalized_attachments:
        request_json["attachments"] = normalized_attachments
    if evidence_payload is not None:
        request_json["evidence"] = evidence_payload

    unsupported_fields: dict[str, Any] = {}
    if package_manifest is not None:
        unsupported_fields["agent_package_manifest"] = _json_clone(package_manifest)
    if cost_tracking is not None:
        unsupported_fields["cost_tracking"] = _json_clone(cost_tracking)

    return ClawHuntSubmissionPayload(
        solution_text=solution_text,
        request_json=request_json,
        adapter_name=adapter_name,
        attachments=normalized_attachments,
        unsupported_fields=unsupported_fields,
        evidence_summary=_evidence_summary(evidence_payload),
    )


def build_clawhunt_delivery_protocol_payload(
    *,
    solution_text: str,
    name: str,
    summary: str,
    evidence: EvidenceBundle | dict[str, Any] | None = None,
    github_pr_url: str | None = None,
    github_pr_number: int | None = None,
    package_manifest: dict[str, Any] | None = None,
    interface_type: str = "workflow",
    level: str | None = None,
    tags: list[str] | None = None,
    limitations: list[str] | None = None,
    certified_for_standard_delivery: bool = False,
    version: str = "0.1.0",
    attachments: list[str] | None = None,
    cost_tracking: dict[str, Any] | None = None,
    adapter_name: str = DELIVERY_PROTOCOL_ADAPTER_NAME,
) -> ClawHuntSubmissionPayload:
    evidence_payload = _evidence_snapshot(evidence)
    manifest = _json_clone(
        package_manifest
        or build_clawhunt_delivery_protocol_manifest(
            name=name,
            summary=summary,
            evidence=evidence,
            version=version,
            interface_type=interface_type,
            level=level,
            tags=tags,
            limitations=limitations,
            certified_for_standard_delivery=certified_for_standard_delivery,
        )
    )
    request_json: dict[str, Any] = {
        "solution_text": solution_text,
        "agent_package_manifest": manifest,
    }
    if github_pr_url:
        request_json["github_pr_url"] = github_pr_url
    if github_pr_number is not None:
        request_json["github_pr_number"] = github_pr_number

    unsupported_fields: dict[str, Any] = {}
    if attachments:
        unsupported_fields["attachments"] = list(attachments)
    if evidence_payload is not None:
        unsupported_fields["evidence"] = evidence_payload
    if cost_tracking is not None:
        unsupported_fields["cost_tracking"] = _json_clone(cost_tracking)

    return ClawHuntSubmissionPayload(
        solution_text=solution_text,
        request_json=request_json,
        adapter_name=adapter_name,
        attachments=list(attachments or []),
        unsupported_fields=unsupported_fields,
        evidence_summary=_evidence_summary(evidence_payload),
    )
