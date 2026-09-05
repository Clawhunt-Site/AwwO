from __future__ import annotations

import copy
import uuid
from datetime import UTC, datetime
from typing import Any, Callable

from studio_app.application.policies.dispatch import accepted_source_media_url


StudioProject = dict[str, Any]
StudioSegment = dict[str, Any]
CLIENT_RESULT_SEGMENT_FIELDS = (
    "type",
    "url",
    "posterUrl",
    "prompt",
    "botId",
    "articleId",
    "botSlug",
    "botName",
    "action",
    "parentSegmentId",
    "status",
    "taskId",
    "jobId",
    "authStatus",
    "evidence",
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def normalize_mode(mode: str, *, valid_modes: set[str]) -> str:
    return mode if mode in valid_modes else "player"


def normalize_action(action: str, *, valid_actions: set[str]) -> str:
    return action if action in valid_actions else "generate"


def normalize_status(status: str | None, *, valid_statuses: set[str]) -> str:
    if status in {"completed", "success"}:
        return "done"
    return status if status in valid_statuses else "running"


def segment_type_for_bot(bot: dict[str, Any]) -> str:
    return "video" if bot.get("type") == "image-to-video" else "image"


def default_agent_graph() -> list[dict[str, Any]]:
    return [
        {
            "id": "intent-router",
            "label": "Intent Router",
            "status": "idle",
            "detail": "Natural language to creative action",
        },
        {
            "id": "asset-planner",
            "label": "Asset Planner",
            "status": "idle",
            "detail": "Selects source segment and media shape",
        },
        {
            "id": "dreamy-executor",
            "label": "Page Executor",
            "status": "idle",
            "detail": "Runs miniapp or MyShell Art generation",
        },
        {
            "id": "timeline",
            "label": "Timeline",
            "status": "idle",
            "detail": "Appends output as a temporary segment",
        },
    ]


def new_project_payload(
    *,
    project_id: str,
    conversation_id: str,
    mode: str,
    updated_at: str,
) -> StudioProject:
    return {
        "projectId": project_id,
        "conversationId": conversation_id,
        "mode": mode,
        "messages": [],
        "segments": [],
        "selectedSegmentId": None,
        "agentGraph": default_agent_graph(),
        "jobs": [],
        "updatedAt": updated_at,
    }


def verified_dreamy_workshop_project_payload(
    *,
    project_id: str,
    segments: list[dict[str, Any]],
    timeline_exports: list[dict[str, Any]],
    checked_at: str,
) -> StudioProject:
    return {
        "projectId": project_id,
        "conversationId": "conversation_verified_workshop",
        "mode": "player",
        "messages": [
            {
                "id": "verified-workshop-user",
                "role": "user",
                "content": "Stage two completed Dreamy workshop bot results into a timeline.",
                "createdAt": "2026-06-03T09:10:00Z",
                "action": "generate",
            },
            {
                "id": "verified-workshop-assistant",
                "role": "assistant",
                "content": "Two real Dreamy workshop outputs are staged. Add another segment or export the timeline.",
                "createdAt": checked_at,
                "action": "extend",
                "segmentId": segments[-1]["id"],
            },
        ],
        "segments": copy.deepcopy(segments),
        "selectedSegmentId": segments[-1]["id"],
        "agentGraph": [
            {"id": "intent-router", "label": "Intent Router", "status": "done", "detail": "Verified workshop route"},
            {"id": "dreamy-bot-1", "label": "3D Anime Porn", "status": "done", "detail": "Real media accepted"},
            {"id": "dreamy-bot-2", "label": "3D Futa Porn", "status": "done", "detail": "Second segment accepted"},
            {"id": "timeline", "label": "Timeline", "status": "done", "detail": "Two clips ready for export"},
        ],
        "jobs": [],
        "timelineExports": timeline_exports,
        "updatedAt": checked_at,
    }


def new_job_payload(
    project: StudioProject,
    segment: StudioSegment,
    route: dict[str, Any],
    page: dict[str, Any],
    *,
    job_id: str,
    agent_id: str,
    auth_status: dict[str, Any],
    evidence: dict[str, Any],
    navigation_contract: dict[str, Any],
    created_at: str,
    updated_at: str,
    status: str = "queued",
) -> dict[str, Any]:
    return {
        "jobId": job_id,
        "projectId": project["projectId"],
        "segmentId": segment["id"],
        "pageId": page["id"],
        "pageName": page["name"],
        "agentId": agent_id,
        "executor": page["executor"],
        "api": page["id"],
        **navigation_contract,
        "status": status,
        "action": segment["action"],
        "botId": segment.get("botId", ""),
        "articleId": segment.get("articleId", ""),
        "botSlug": segment["botSlug"],
        "botName": segment["botName"],
        "botType": route["bot"].get("type"),
        "prompt": segment["prompt"],
        "taskId": "",
        "mediaUrl": "",
        "posterUrl": segment.get("posterUrl", ""),
        "authStatus": auth_status,
        "evidence": evidence,
        "attempt": 1,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def cancel_job_patch(evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "cancelled",
        "evidence": evidence,
    }


def retry_job_patch(job: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "queued",
        "attempt": int(job.get("attempt") or 1) + 1,
        "evidence": evidence,
    }


def should_skip_bulk_job_action(
    job: dict[str, Any],
    *,
    action: str,
    include_terminal: bool,
    terminal_cancel_statuses: set[str],
) -> bool:
    return action == "cancel" and not include_terminal and job.get("status") in terminal_cancel_statuses


def bulk_job_action_response(
    *,
    action: str,
    updated_jobs: list[dict[str, Any]],
    skipped_jobs: list[dict[str, Any]],
    projects_by_id: dict[str, StudioProject],
    execution_requests: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "action": action,
        "matchedCount": len(updated_jobs),
        "skippedCount": len(skipped_jobs),
        "jobs": updated_jobs,
        "skippedJobs": skipped_jobs,
        "projects": list(projects_by_id.values()),
        "executionRequests": execution_requests,
    }


def sync_segment_from_job_status(
    project: StudioProject,
    job: dict[str, Any],
    *,
    updated_at: str,
) -> StudioSegment | None:
    segment = find_segment(project, str(job.get("segmentId") or ""))
    if segment:
        segment["status"] = job.get("status") or segment.get("status")
        if job.get("evidence") is not None:
            segment["evidence"] = job.get("evidence")
        segment["updatedAt"] = updated_at
    project["updatedAt"] = updated_at
    return segment


def new_client_result_segment(
    payload: dict[str, Any],
    *,
    segment_id: str,
    bot: dict[str, Any],
    segment_type: str,
    auth_status: dict[str, Any],
    created_at: str,
    updated_at: str,
) -> StudioSegment:
    return {
        "id": segment_id,
        "type": payload.get("type") or segment_type,
        "url": "",
        "posterUrl": "",
        "prompt": payload.get("prompt") or "",
        "botId": payload.get("botId") or "",
        "articleId": payload.get("articleId") or bot["slug"],
        "botSlug": bot["slug"],
        "botName": bot["name"],
        "action": payload.get("action") or "generate",
        "parentSegmentId": payload.get("parentSegmentId"),
        "status": "running",
        "taskId": "",
        "jobId": payload.get("jobId", ""),
        "authStatus": payload.get("authStatus") or auth_status,
        "evidence": {},
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def client_result_status_payload(
    payload: dict[str, Any],
    normalized_status: str,
    *,
    missing_media_evidence: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    if normalized_status == "done" and not payload.get("url"):
        return "error", {
            **payload,
            "status": "error",
            "evidence": missing_media_evidence,
        }
    return normalized_status, payload


def client_result_default_evidence(
    normalized_status: str,
    segment: StudioSegment,
    *,
    source: str,
    checked_at: str,
) -> dict[str, Any]:
    accepted = normalized_status == "done" and bool(segment.get("url"))
    return evidence(
        normalized_status,
        source,
        checked_at=checked_at,
        accepted=accepted,
        media_url=segment.get("url") or "",
        task_id=segment.get("taskId") or "",
        message=(
            "Fresh Dreamy task media accepted."
            if accepted
            else "Client result registered; waiting for final media."
        ),
    )


def apply_client_result_payload(
    segment: StudioSegment,
    payload: dict[str, Any],
    *,
    normalized_status: str,
    source: str,
    auth_status: dict[str, Any],
    updated_at: str,
) -> StudioSegment:
    for key in CLIENT_RESULT_SEGMENT_FIELDS:
        if key in payload and payload[key] is not None:
            segment[key] = payload[key]
    segment["status"] = normalized_status
    if "evidence" not in payload:
        segment["evidence"] = client_result_default_evidence(
            normalized_status,
            segment,
            source=source,
            checked_at=updated_at,
        )
    segment.setdefault("authStatus", auth_status)
    segment["updatedAt"] = updated_at
    return segment


def client_result_graph_route(segment: StudioSegment) -> dict[str, Any]:
    return {
        "bot": {
            "slug": segment.get("botSlug"),
            "name": segment.get("botName"),
            "type": segment.get("type"),
        },
        "executor": "client",
        "analysis": "Client result registered.",
        "sourceSummary": "Timeline updated.",
    }


def client_result_assistant_message(segment: StudioSegment) -> str:
    return f"Segment {segment['id']} is {segment.get('status', 'updated')}."


def client_result_job_patch(
    segment: StudioSegment,
    normalized_status: str,
    job: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": normalized_status,
        "botId": segment.get("botId") or job.get("botId"),
        "articleId": segment.get("articleId") or job.get("articleId"),
        "taskId": segment.get("taskId") or job.get("taskId"),
        "mediaUrl": segment.get("url") or job.get("mediaUrl"),
        "posterUrl": segment.get("posterUrl") or job.get("posterUrl"),
        "evidence": segment.get("evidence"),
        "authStatus": segment.get("authStatus"),
    }


def queued_segment_payload(
    route: dict[str, Any],
    *,
    segment_id: str,
    segment_type: str,
    prompt: str,
    action: str,
    source_segment_id: str | None,
    poster_url: str,
    evidence: dict[str, Any],
    created_at: str,
    updated_at: str,
) -> StudioSegment:
    bot = route["bot"]
    return {
        "id": segment_id,
        "type": segment_type,
        "url": "",
        "posterUrl": poster_url,
        "prompt": prompt,
        "botId": str(bot.get("id") or bot.get("botId") or ""),
        "articleId": str(bot.get("articleId") or bot.get("slug") or ""),
        "botSlug": bot["slug"],
        "botName": bot["name"],
        "action": action,
        "parentSegmentId": source_segment_id,
        "status": "queued",
        "taskId": "",
        "jobId": "",
        "authStatus": {},
        "evidence": evidence,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def append_segment(project: StudioProject, segment: StudioSegment, *, updated_at: str) -> StudioSegment:
    project["segments"].append(segment)
    project["selectedSegmentId"] = segment["id"]
    project["updatedAt"] = updated_at
    return segment


def set_graph_status(
    project: StudioProject,
    route: dict[str, Any],
    segment: StudioSegment | None = None,
) -> list[dict[str, Any]]:
    graph = default_agent_graph()
    graph[0]["status"] = "done"
    graph[0]["detail"] = route.get("analysis") or "Intent understood"
    graph[1]["status"] = "done"
    graph[1]["detail"] = route.get("sourceSummary") or "Using current prompt"
    graph[2]["status"] = "running" if segment and segment.get("status") in {"queued", "running"} else "done"
    graph[2]["detail"] = f"{route['bot']['name']} via {route['executor']}"
    graph[3]["status"] = "queued" if segment and segment.get("status") in {"queued", "running"} else "idle"
    graph[3]["detail"] = "Segment queued in project timeline" if segment else "Waiting for output"
    project["agentGraph"] = graph
    return graph


def find_segment(project: StudioProject, segment_id: str | None) -> StudioSegment | None:
    if not segment_id:
        return None
    for segment in project.get("segments", []):
        if segment.get("id") == segment_id:
            return segment
    return None


def latest_accepted_media_segment(project: StudioProject | None) -> StudioSegment | None:
    if not project:
        return None
    for segment in reversed(project.get("segments", [])):
        if accepted_source_media_url(segment):
            return segment
    return None


def resolve_source_segment(project: StudioProject | None, segment_id: str | None) -> StudioSegment | None:
    if not project:
        return None
    requested = find_segment(project, segment_id)
    if accepted_source_media_url(requested):
        return requested
    return latest_accepted_media_segment(project)


def append_message(
    project: StudioProject,
    role: str,
    content: str,
    *,
    make_id: Callable[[str], str],
    now_iso: Callable[[], str],
    save_project: Callable[[StudioProject], None],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = now_iso()
    message = {
        "id": make_id("message"),
        "role": role,
        "content": content,
        "createdAt": now,
        **(extra or {}),
    }
    project["messages"].append(message)
    project["updatedAt"] = now_iso()
    save_project(project)
    return message


def evidence(
    status: str,
    source: str,
    *,
    checked_at: str,
    accepted: bool = False,
    message: str = "",
    media_url: str = "",
    task_id: str = "",
) -> dict[str, Any]:
    return {
        "status": status,
        "source": source,
        "accepted": accepted,
        "mediaUrl": media_url,
        "taskId": task_id,
        "message": message,
        "checkedAt": checked_at,
    }


def exception_message(exc: Exception) -> str:
    detail = str(exc)
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


def job_with_evidence(job: dict[str, Any] | None, evidence_trail: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not job:
        return None
    enriched = dict(job)
    enriched["evidenceTrail"] = evidence_trail
    return enriched


def delivery_action_for_status(status: str, evidence: dict[str, Any]) -> dict[str, Any] | None:
    if status in {"draft", "queued"}:
        return {
            "action": "wait-for-adapter",
            "status": status,
            "message": evidence.get("message") or "Adapter output has not been accepted yet.",
        }
    if status == "running":
        return {
            "action": "poll-result",
            "status": status,
            "message": evidence.get("message") or "Job is still running; refresh or wait for result evidence.",
        }
    if status == "auth_missing":
        return {
            "action": "restore-auth",
            "status": status,
            "message": evidence.get("message") or "Authentication is missing for this adapter.",
        }
    if status == "timeout":
        return {
            "action": "retry-or-cancel",
            "status": status,
            "message": evidence.get("message") or "Adapter timed out before returning accepted evidence.",
        }
    if status == "error":
        return {
            "action": "inspect-error",
            "status": status,
            "message": evidence.get("message") or "Adapter reported an error.",
        }
    if status == "done" and not evidence.get("accepted"):
        return {
            "action": "verify-evidence",
            "status": status,
            "message": evidence.get("message") or "Done status needs accepted media evidence.",
        }
    return None


def project_delivery_report(
    project: StudioProject,
    *,
    jobs: list[dict[str, Any] | None],
    status_counts: dict[str, int],
    checked_at: str,
    pending_statuses: set[str],
    issue_statuses: set[str],
) -> dict[str, Any]:
    jobs = [job for job in jobs if job]
    jobs_by_id = {job["jobId"]: job for job in jobs}
    jobs_by_segment: dict[str, dict[str, Any]] = {}
    for job in jobs:
        if job.get("segmentId") and job.get("segmentId") not in jobs_by_segment:
            jobs_by_segment[str(job["segmentId"])] = job

    segment_reports: list[dict[str, Any]] = []
    unresolved_actions: list[dict[str, Any]] = []
    accepted_evidence = 0
    pending_evidence = 0
    issue_count = 0

    for segment in project.get("segments", []):
        job = jobs_by_id.get(segment.get("jobId")) or jobs_by_segment.get(segment.get("id")) or {}
        evidence_payload = segment.get("evidence") or job.get("evidence") or {}
        evidence_trail = job.get("evidenceTrail") or []
        status = str(segment.get("status") or job.get("status") or "draft")
        if evidence_payload.get("accepted"):
            accepted_evidence += 1
        if status in pending_statuses or (status == "done" and not evidence_payload.get("accepted")):
            pending_evidence += 1
        if status in issue_statuses:
            issue_count += 1

        action = delivery_action_for_status(status, evidence_payload)
        if action:
            unresolved_actions.append(
                {
                    **action,
                    "segmentId": segment.get("id"),
                    "jobId": job.get("jobId") or segment.get("jobId") or "",
                    "pageId": job.get("pageId") or job.get("api") or "",
                    "botName": segment.get("botName") or job.get("botName") or "",
                }
            )

        segment_reports.append(
            {
                "segmentId": segment.get("id"),
                "jobId": job.get("jobId") or segment.get("jobId") or "",
                "pageId": job.get("pageId") or job.get("api") or "",
                "pageName": job.get("pageName") or "",
                "agentId": job.get("agentId") or "",
                "status": status,
                "botName": segment.get("botName") or job.get("botName") or "",
                "mediaUrl": segment.get("url") or job.get("mediaUrl") or "",
                "posterUrl": segment.get("posterUrl") or job.get("posterUrl") or "",
                "taskId": segment.get("taskId") or job.get("taskId") or "",
                "authStatus": segment.get("authStatus") or job.get("authStatus") or {},
                "evidence": evidence_payload,
                "evidenceTrail": evidence_trail,
                "updatedAt": segment.get("updatedAt") or job.get("updatedAt") or "",
            }
        )

    ready_for_handoff = bool(jobs) and not unresolved_actions and accepted_evidence > 0 and issue_count == 0
    handoff_status = "ready" if ready_for_handoff else "needs_attention" if issue_count else "in_progress"

    return {
        "projectId": project["projectId"],
        "conversationId": project.get("conversationId", ""),
        "checkedAt": checked_at,
        "handoffStatus": handoff_status,
        "readyForHandoff": ready_for_handoff,
        "summary": {
            "totalSegments": len(project.get("segments", [])),
            "totalJobs": len(jobs),
            "acceptedEvidence": accepted_evidence,
            "pendingEvidence": pending_evidence,
            "issueCount": issue_count,
            "unresolvedActionCount": len(unresolved_actions),
        },
        "statusCounts": status_counts,
        "segments": segment_reports,
        "jobs": jobs,
        "unresolvedActions": unresolved_actions,
    }


def project_delivery_bundle(
    project: StudioProject,
    *,
    delivery_report: dict[str, Any],
    coverage: dict[str, Any],
    handoff: dict[str, Any],
    dispatch_sessions: list[dict[str, Any]],
    jobs: list[dict[str, Any] | None],
    artifacts: list[dict[str, Any]],
    checked_at: str,
) -> dict[str, Any]:
    jobs = [job for job in jobs if job]
    accepted_jobs = [job for job in jobs if (job.get("evidence") or {}).get("accepted")]

    all_targets = [target for session in dispatch_sessions for target in session.get("targets", [])]
    batch_skipped_targets = [target for session in dispatch_sessions for target in session.get("skippedTargets", [])]
    operator_skipped_targets = [
        {
            **target,
            "reason": target.get("reason") or "operator_skipped",
            "message": target.get("message") or (target.get("evidence") or {}).get("reason") or "Operator skipped this target.",
        }
        for target in all_targets
        if target.get("status") == "skipped"
    ]
    skipped_targets = [*batch_skipped_targets, *operator_skipped_targets]
    remaining_targets = [target for target in all_targets if target.get("status", "pending") in {"pending", "visited"}]
    error_targets = [
        {
            **target,
            "message": target.get("message") or (target.get("evidence") or {}).get("message") or "Target needs operator review.",
        }
        for target in all_targets
        if target.get("status") == "error"
    ]
    cancelled_targets = [
        {
            **target,
            "message": target.get("message") or (target.get("evidence") or {}).get("message") or "Target was cancelled before completion.",
        }
        for target in all_targets
        if target.get("status") == "cancelled"
    ]
    target_status_counts = {
        "pending": sum(1 for target in all_targets if target.get("status", "pending") == "pending"),
        "visited": sum(1 for target in all_targets if target.get("status") == "visited"),
        "completed": sum(1 for target in all_targets if target.get("status") == "completed"),
        "skipped": sum(1 for target in all_targets if target.get("status") == "skipped"),
        "error": sum(1 for target in all_targets if target.get("status") == "error"),
        "cancelled": sum(1 for target in all_targets if target.get("status") == "cancelled"),
        "blocked": len(batch_skipped_targets),
        "remaining": len(remaining_targets),
        "total": len(all_targets) + len(batch_skipped_targets),
    }

    return {
        "status": handoff.get("status"),
        "readyForDelivery": handoff.get("readyForDelivery", False),
        "checkedAt": checked_at,
        "projectId": project["projectId"],
        "conversationId": project.get("conversationId", ""),
        "sourceSegmentId": coverage.get("sourceSegmentId"),
        "sourceMediaUrl": coverage.get("sourceMediaUrl", ""),
        "summary": {
            "pages": (coverage.get("summary") or {}).get("total", 0),
            "covered": (coverage.get("summary") or {}).get("covered", 0),
            "readyUnverified": (coverage.get("summary") or {}).get("readyUnverified", 0),
            "blockedPages": (coverage.get("summary") or {}).get("blocked", 0),
            "jobs": len(jobs),
            "acceptedJobs": len(accepted_jobs),
            "dispatchSessions": len(dispatch_sessions),
            "dispatchTargets": target_status_counts["total"],
            "remainingTargets": target_status_counts["remaining"],
            "pendingTargets": target_status_counts["pending"],
            "visitedTargets": target_status_counts["visited"],
            "completedTargets": target_status_counts["completed"],
            "skippedTargets": target_status_counts["skipped"],
            "errorTargets": target_status_counts["error"],
            "cancelledTargets": target_status_counts["cancelled"],
            "blockedTargets": target_status_counts["blocked"],
            "gaps": len(handoff.get("gaps") or []),
            "actions": len(handoff.get("actions") or []),
            "artifacts": len(artifacts),
        },
        "targetStatusCounts": target_status_counts,
        "artifacts": artifacts,
        "dispatchSessions": dispatch_sessions,
        "acceptedJobs": accepted_jobs,
        "remainingTargets": remaining_targets,
        "skippedTargets": skipped_targets,
        "errorTargets": error_targets,
        "cancelledTargets": cancelled_targets,
        "reports": {
            "deliveryReport": delivery_report,
            "coverage": coverage,
            "handoffSnapshot": handoff,
        },
    }
