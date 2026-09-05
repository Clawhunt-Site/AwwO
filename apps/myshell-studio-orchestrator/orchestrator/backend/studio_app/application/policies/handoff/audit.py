from __future__ import annotations

from typing import Any

from studio_app.application.policies.handoff.actions import action_with_operator_instruction
from studio_app.application.policies.handoff.artifacts import gate_status_from_report


def audit_status(requirements: list[dict[str, Any]]) -> str:
    if any(item.get("required") and item.get("status") in {"blocked", "error"} for item in requirements):
        return "blocked"
    if any(item.get("status") != "ready" for item in requirements):
        return "degraded"
    return "ready"

def requirement(
    requirement_id: str,
    label: str,
    status: str,
    *,
    required: bool = True,
    message: str = "",
    evidence: dict[str, Any] | None = None,
    ready_statuses: set[str],
) -> dict[str, Any]:
    normalized_status = "ready" if status in ready_statuses else status
    return {
        "id": requirement_id,
        "label": label,
        "status": normalized_status,
        "required": required,
        "message": message,
        "evidence": evidence or {},
    }

def requirement_from_gate(gate: dict[str, Any], *, ready_statuses: set[str]) -> dict[str, Any]:
    return requirement(
        str(gate.get("id") or ""),
        str(gate.get("label") or gate.get("id") or ""),
        str(gate.get("status") or "unknown"),
        required=bool(gate.get("required", True)),
        message=str(gate.get("message") or ""),
        evidence=gate.get("evidence") if isinstance(gate.get("evidence"), dict) else {},
        ready_statuses=ready_statuses,
    )

def audit_action_for_requirement(requirement: dict[str, Any]) -> dict[str, Any] | None:
    status = str(requirement.get("status") or "")
    if status == "ready":
        return None
    requirement_id = str(requirement.get("id") or "")
    label = str(requirement.get("label") or requirement_id)
    action = "inspect-requirement"
    if status in {"auth_missing", "needs_configuration"} or "auth" in requirement_id or "cookie" in requirement_id:
        action = "restore-auth"
    elif requirement_id == "chrome-cdp":
        action = "start-chrome-cdp"
    elif requirement_id == "handoff-snapshot":
        action = "provide-project-id"
    elif requirement_id == "dispatch-matrix":
        action = "inspect-dispatch-matrix"
    return {
        "id": f"audit:{action}:{requirement_id}",
        "action": action,
        "kind": "requirement",
        "targetId": requirement_id,
        "targetName": label,
        "status": status,
        "reason": status,
        "message": str(requirement.get("message") or ""),
    }

def delivery_audit_actions(
    requirements: list[dict[str, Any]],
    handoff: dict[str, Any] | None,
    *,
    manual_actions: set[str],
) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for item in requirements:
        action = audit_action_for_requirement(item)
        if action:
            actions.append(action)
    if handoff and isinstance(handoff.get("actions"), list):
        actions.extend(list(handoff.get("actions") or []))

    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for action in actions:
        action_id = str(action.get("id") or "")
        if action_id and action_id in seen_ids:
            continue
        if action_id:
            seen_ids.add(action_id)
        deduped.append(action_with_operator_instruction(action, manual_actions=manual_actions))
    return deduped

def delivery_audit_requirements(
    *,
    readiness: dict[str, Any],
    dispatch_matrix: dict[str, Any],
    generation_smoke: dict[str, Any],
    generation_prerequisites: dict[str, Any],
    handoff: dict[str, Any] | None,
    project: dict[str, Any] | None,
    core_page_count: int,
    ready_statuses: set[str],
) -> list[dict[str, Any]]:
    readiness_gates = [
        requirement_from_gate(gate, ready_statuses=ready_statuses)
        for gate in readiness.get("gates") or []
    ]
    matrix_summary = dispatch_matrix.get("summary") or {}
    requirements = [
        *readiness_gates,
        requirement(
            "dispatch-matrix",
            "Dispatch Matrix",
            "ready" if matrix_summary.get("total", 0) >= core_page_count else "blocked",
            message=f"{matrix_summary.get('ready', 0)}/{matrix_summary.get('total', 0)} targets ready",
            evidence=matrix_summary,
            ready_statuses=ready_statuses,
        ),
        requirement(
            "live-generation-smoke",
            "Live Generation Smoke",
            "ready"
            if generation_smoke.get("status") == "done" and (generation_smoke.get("latest") or {}).get("accepted")
            else str(generation_smoke.get("status") or "needs_verification"),
            message=str(generation_smoke.get("message") or ""),
            evidence={
                "endpoint": "/api/studio/generation-smoke",
                "readyForLiveRun": bool(generation_smoke.get("readyForLiveRun")),
                "latest": generation_smoke.get("latest") or {},
                "missingEnv": (generation_prerequisites.get("missingEnv") or []),
            },
            ready_statuses=ready_statuses,
        ),
    ]

    if handoff:
        project_id = str((project or {}).get("projectId") or "")
        requirements.append(
            requirement(
                "handoff-snapshot",
                "Handoff Snapshot",
                gate_status_from_report(str(handoff.get("status") or "unknown")),
                message=f"{(handoff.get('summary') or {}).get('covered', 0)}/{(handoff.get('summary') or {}).get('pages', 0)} pages covered",
                evidence={
                    "readyForDelivery": bool(handoff.get("readyForDelivery")),
                    "gaps": len(handoff.get("gaps") or []),
                    "actions": len(handoff.get("actions") or []),
                },
                ready_statuses=ready_statuses,
            )
        )
        requirements.append(
            requirement(
                "downloadable-delivery-bundle",
                "Downloadable Delivery Bundle",
                "ready",
                message="Delivery bundle can be downloaded as JSON",
                evidence={
                    "endpoint": "/api/studio/projects/{project_id}/delivery-bundle",
                    "query": {"download": 1},
                    "filename": f"myshell-studio-delivery-{project_id}.json",
                },
                ready_statuses=ready_statuses,
            )
        )
    else:
        requirements.append(
            requirement(
                "handoff-snapshot",
                "Handoff Snapshot",
                "ready",
                required=False,
                message="Pass project_id to include project delivery evidence.",
                evidence={"projectContext": "not_selected"},
                ready_statuses=ready_statuses,
            )
        )
    return requirements

def delivery_audit_response(
    *,
    checked_at: str,
    project: dict[str, Any] | None,
    dispatch_matrix: dict[str, Any],
    readiness: dict[str, Any],
    overview: dict[str, Any],
    coverage: dict[str, Any],
    delivery_report: dict[str, Any] | None,
    handoff: dict[str, Any] | None,
    generation_smoke: dict[str, Any],
    pages: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    core_page_ids: set[str],
    core_agent_ids: set[str],
    requirements: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    page_ids = {page["id"] for page in pages}
    agent_ids = {agent["id"] for agent in agents}
    missing_core_pages = sorted(core_page_ids - page_ids)
    missing_core_agents = sorted(core_agent_ids - agent_ids)
    matrix_summary = dispatch_matrix.get("summary") or {}
    return {
        "status": audit_status(requirements),
        "checkedAt": checked_at,
        "projectId": project.get("projectId") if project else None,
        "sourceSegmentId": dispatch_matrix.get("sourceSegmentId"),
        "sourceMediaUrl": dispatch_matrix.get("sourceMediaUrl", ""),
        "summary": {
            "pages": len(pages),
            "agents": len(agents),
            "readyTargets": matrix_summary.get("ready", 0),
            "missingParams": matrix_summary.get("missingParams", 0),
            "missingCorePages": len(missing_core_pages),
            "missingCoreAgents": len(missing_core_agents),
            "readinessGates": (readiness.get("summary") or {}).get("total", 0),
            "readinessReady": (readiness.get("summary") or {}).get("ready", 0),
            "jobs": (overview.get("totals") or {}).get("jobs", 0),
            "artifacts": len(artifacts),
            "actions": len(actions),
        },
        "requirements": requirements,
        "actions": actions,
        "artifacts": artifacts,
        "reports": {
            "health": readiness.get("health") or {},
            "readiness": readiness,
            "overview": overview,
            "dispatchMatrix": dispatch_matrix,
            "coverage": coverage,
            "deliveryReport": delivery_report,
            "handoffSnapshot": handoff,
            "generationSmoke": generation_smoke,
        },
    }
