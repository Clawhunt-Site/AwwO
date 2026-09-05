from __future__ import annotations

from typing import Any

from studio_app.application.policies.handoff.actions import action_with_operator_instruction
from studio_app.application.policies.handoff.artifacts import (
    dispatch_session_ui_url,
    gate_status_from_report,
    handoff_artifacts,
)


def handoff_gaps_and_actions(
    *,
    coverage: dict[str, Any],
    delivery_report: dict[str, Any] | None,
    dispatch_sessions: list[dict[str, Any]],
    manual_actions: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    gaps: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for page in coverage.get("pages") or []:
        if page.get("coverageStatus") == "covered":
            continue
        reason, action = coverage_gap_action(page)
        gap = {
            "id": f"coverage:{page.get('pageId')}",
            "kind": "page",
            "pageId": page.get("pageId"),
            "pageName": page.get("pageName"),
            "status": page.get("coverageStatus"),
            "reason": reason,
            "message": page.get("dispatchMessage") or (page.get("latestEvidence") or {}).get("message") or "",
            "missingRouteParams": page.get("missingRouteParams") or [],
        }
        gaps.append(gap)
        actions.append(
            {
                "id": f"{action}:{page.get('pageId')}",
                "action": action,
                "kind": "page",
                "targetId": page.get("pageId"),
                "targetName": page.get("pageName"),
                "status": page.get("coverageStatus"),
                "reason": reason,
                "message": gap["message"],
            }
        )

    for unresolved in (delivery_report or {}).get("unresolvedActions") or []:
        actions.append(
            {
                "id": f"job:{unresolved.get('action')}:{unresolved.get('jobId') or unresolved.get('segmentId')}",
                "action": unresolved.get("action"),
                "kind": "job",
                "targetId": unresolved.get("jobId") or unresolved.get("segmentId"),
                "targetName": unresolved.get("botName") or unresolved.get("pageId"),
                "status": unresolved.get("status"),
                "reason": unresolved.get("action"),
                "message": unresolved.get("message") or "",
                "pageId": unresolved.get("pageId"),
                "segmentId": unresolved.get("segmentId"),
                "jobId": unresolved.get("jobId"),
            }
        )

    for session in dispatch_sessions:
        session_id = str(session.get("sessionId") or "")
        for target in session.get("targets") or []:
            target_status = str(target.get("status") or "pending")
            if target_status not in {"pending", "visited", "error", "cancelled"}:
                continue
            target_id = str(target.get("id") or "")
            evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
            if target_status == "pending":
                reason = "pending"
                action = "run-target"
                message = str(target.get("message") or evidence.get("message") or "Dispatch target is pending; run it from the Studio queue.")
            elif target_status == "visited":
                reason = "visited"
                action = "inspect-gap"
                message = str(
                    target.get("message")
                    or evidence.get("message")
                    or "Dispatch target was opened but has not been marked done, skipped, or error."
                )
            elif target_status == "cancelled":
                reason = "cancelled"
                action = "retry-queue"
                message = str(
                    target.get("message")
                    or evidence.get("message")
                    or "Dispatch target was cancelled before completion; retry the queue to reopen it."
                )
            else:
                reason = "error"
                action = "inspect-gap"
                message = str(target.get("message") or evidence.get("message") or "Dispatch target needs operator review.")

            gap = {
                "id": f"dispatch-session:{session_id}:{target_id}",
                "kind": "dispatch_target",
                "pageId": target.get("pageId"),
                "pageName": target.get("pageName"),
                "status": target_status,
                "reason": reason,
                "message": message,
                "missingRouteParams": target.get("missingRouteParams") or [],
                "sessionId": session_id,
                "targetId": target_id,
            }
            gaps.append(gap)
            actions.append(
                {
                    "id": f"dispatch-target:{action}:{session_id}:{target_id}",
                    "action": action,
                    "kind": "dispatch_target",
                    "targetId": target_id,
                    "targetName": target.get("pageName") or target.get("pageId"),
                    "status": target_status,
                    "reason": reason,
                    "message": message,
                    "pageId": target.get("pageId"),
                    "sessionId": session_id,
                    "uiUrl": dispatch_session_ui_url(session_id, target_id),
                }
            )
    return gaps, [action_with_operator_instruction(action, manual_actions=manual_actions) for action in actions]

def handoff_status(
    *,
    readiness: dict[str, Any],
    coverage: dict[str, Any],
    delivery_report: dict[str, Any] | None,
    gaps: list[dict[str, Any]],
) -> str:
    if readiness.get("status") == "blocked":
        return "blocked"
    if coverage.get("status") == "blocked" or coverage.get("summary", {}).get("blocked", 0) > 0:
        return "blocked"
    if (delivery_report or {}).get("handoffStatus") == "needs_attention":
        return "blocked"
    if gaps:
        return "needs_attention"
    if (delivery_report or {}).get("handoffStatus") == "in_progress":
        return "needs_attention"
    return "ready"

def handoff_snapshot_response(
    *,
    checked_at: str,
    project: dict[str, Any] | None,
    health: dict[str, Any],
    readiness: dict[str, Any],
    overview: dict[str, Any],
    dispatch_matrix: dict[str, Any],
    coverage: dict[str, Any],
    delivery_report: dict[str, Any] | None,
    gaps: list[dict[str, Any]],
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    status = handoff_status(
        readiness=readiness,
        coverage=coverage,
        delivery_report=delivery_report,
        gaps=gaps,
    )
    coverage_summary = coverage.get("summary") or {}
    delivery_summary = (delivery_report or {}).get("summary") or {}
    overview_totals = overview.get("totals") or {}

    gates = [
        {
            "id": "health",
            "label": "Health",
            "status": gate_status_from_report(str(health.get("status") or "unknown")),
            "message": str(health.get("status") or ""),
            "required": True,
        },
        {
            "id": "readiness",
            "label": "Studio Readiness",
            "status": gate_status_from_report(str(readiness.get("status") or "unknown")),
            "message": f"{readiness.get('summary', {}).get('ready', 0)}/{readiness.get('summary', {}).get('total', 0)} gates ready",
            "required": True,
        },
        {
            "id": "coverage",
            "label": "Page Coverage",
            "status": gate_status_from_report(str(coverage.get("status") or "unknown")),
            "message": f"{coverage_summary.get('covered', 0)}/{coverage_summary.get('total', 0)} pages covered",
            "required": True,
        },
        {
            "id": "dispatch-matrix",
            "label": "Dispatch Matrix",
            "status": "ready"
            if dispatch_matrix.get("summary", {}).get("ready", 0) >= dispatch_matrix.get("summary", {}).get("total", 0)
            else "needs_attention",
            "message": f"{dispatch_matrix.get('summary', {}).get('ready', 0)}/{dispatch_matrix.get('summary', {}).get('total', 0)} targets ready",
            "required": True,
        },
    ]
    if delivery_report:
        gates.append(
            {
                "id": "project-delivery",
                "label": "Project Delivery",
                "status": gate_status_from_report(str(delivery_report.get("handoffStatus") or "unknown")),
                "message": f"{delivery_summary.get('acceptedEvidence', 0)} accepted evidence items",
                "required": True,
            }
        )

    project_id = project.get("projectId") if project else None
    source_segment_id = coverage.get("sourceSegmentId")
    return {
        "status": status,
        "readyForDelivery": status == "ready",
        "checkedAt": checked_at,
        "projectId": project_id,
        "sourceSegmentId": source_segment_id,
        "sourceMediaUrl": coverage.get("sourceMediaUrl", ""),
        "summary": {
            "pages": coverage_summary.get("total", 0),
            "covered": coverage_summary.get("covered", 0),
            "pending": coverage_summary.get("pending", 0),
            "readyUnverified": coverage_summary.get("readyUnverified", 0),
            "blocked": coverage_summary.get("blocked", 0),
            "acceptedEvidence": coverage_summary.get("acceptedEvidence", 0),
            "jobs": overview_totals.get("jobs", 0),
            "issues": overview_totals.get("issues", 0) + coverage_summary.get("issues", 0),
            "deliveryAcceptedEvidence": delivery_summary.get("acceptedEvidence", 0),
            "deliveryPendingEvidence": delivery_summary.get("pendingEvidence", 0),
            "unresolvedActions": len(actions),
            "gaps": len(gaps),
        },
        "gates": gates,
        "gaps": gaps,
        "actions": actions,
        "artifacts": handoff_artifacts(project_id, source_segment_id),
        "reports": {
            "health": health,
            "readiness": readiness,
            "overview": overview,
            "dispatchMatrix": dispatch_matrix,
            "coverage": coverage,
            "deliveryReport": delivery_report,
        },
    }

def coverage_gap_action(page: dict[str, Any]) -> tuple[str, str]:
    missing_params = page.get("missingRouteParams") or []
    dispatch_status = str(page.get("dispatchStatus") or "")
    coverage_status = str(page.get("coverageStatus") or "")
    if dispatch_status == "auth_missing":
        return "auth_missing", "restore-auth"
    if missing_params:
        return "missing_params", "provide-route-params"
    if coverage_status == "ready_unverified":
        return "ready_unverified", "verify-ready"
    if coverage_status == "pending":
        return "pending", "wait-or-refresh"
    if dispatch_status in {"error", "timeout"}:
        return dispatch_status, "retry-or-inspect"
    if not page.get("dispatchReady"):
        return dispatch_status or coverage_status or "not_ready", "restore-readiness"
    return coverage_status or dispatch_status or "needs_attention", "inspect-gap"
