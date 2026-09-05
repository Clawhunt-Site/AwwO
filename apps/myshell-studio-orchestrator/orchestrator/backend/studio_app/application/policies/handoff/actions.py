from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from studio_app.application.policies.handoff.artifacts import dispatch_session_ui_url


def operator_action_url(
    endpoint: str,
    target_id: str,
    query: dict[str, Any] | None = None,
    *,
    project_id: str | None = None,
    session_id: str | None = None,
) -> str:
    encoded_target = quote(str(target_id), safe="")
    encoded_project = quote(str(project_id or target_id), safe="")
    encoded_session = quote(str(session_id or target_id), safe="")
    url = (
        endpoint.replace("{job_id}", encoded_target)
        .replace("{project_id}", encoded_project)
        .replace("{session_id}", encoded_session)
    )
    clean_query = {
        key: value
        for key, value in (query or {}).items()
        if value is not None and value != ""
    }
    if clean_query:
        delimiter = "&" if "?" in url else "?"
        url = f"{url}{delimiter}{urlencode(clean_query)}"
    return url

def materialize_operator_instruction(instruction: dict[str, Any]) -> dict[str, Any]:
    materialized = dict(instruction)
    target_id = str(materialized.get("targetId") or "")
    project_id = str(materialized.get("projectId") or "") or None
    session_id = str(materialized.get("sessionId") or "") or None
    endpoint_query: dict[str, Any] = {}
    raw_query = materialized.get("query")
    if isinstance(raw_query, dict):
        endpoint_query = {
            str(key): value
            for key, value in raw_query.items()
            if value is not None and value != ""
        }
    if materialized.get("endpoint") == "/api/studio/dispatch-preview" and target_id:
        endpoint_query["page_id"] = target_id
        materialized["query"] = endpoint_query
    elif endpoint_query:
        materialized["query"] = endpoint_query

    for field, url_field in (
        ("endpoint", "url"),
        ("retryEndpoint", "retryUrl"),
        ("cancelEndpoint", "cancelUrl"),
    ):
        endpoint = materialized.get(field)
        if endpoint:
            query = endpoint_query if field == "endpoint" else None
            concrete_url = operator_action_url(
                str(endpoint),
                target_id,
                query,
                project_id=project_id,
                session_id=session_id,
            )
            materialized[field] = concrete_url
            materialized[url_field] = concrete_url
    return materialized

def manual_action_instruction(action: str, target_id: str, *, session_id: str | None = None) -> dict[str, Any]:
    if action == "restore-auth":
        if target_id in {"live-generation-smoke", "liveGeneration", "credentialSetup"}:
            return {
                "label": "Restore live generation auth",
                "message": "Set DREAMY_TELEGRAM_INIT_DATA and MYSHELL_COOKIES, or create the Cloud Run secrets myshell-dreamy-init-data and myshell-cookies, then redeploy and run the live generation smoke.",
                "env": "DREAMY_TELEGRAM_INIT_DATA,MYSHELL_COOKIES",
                "endpoint": "/api/studio/generation-smoke",
                "targetId": target_id,
            }
        return {
            "label": "Restore MyShell auth",
            "message": "Set MYSHELL_COOKIES or myshell-cookies.json, then restart the backend and refresh readiness.",
            "env": "MYSHELL_COOKIES",
            "targetId": target_id,
        }
    if action == "start-chrome-cdp":
        return {
            "label": "Start Chrome CDP",
            "message": "Start Chrome with remote debugging on port 9222 or set MYSHELL_CDP_URL, then refresh readiness.",
            "command": "Google Chrome --remote-debugging-port=9222",
            "env": "MYSHELL_CDP_URL",
            "targetId": target_id,
        }
    if action == "provide-project-id":
        return {
            "label": "Select a Studio project",
            "message": "Create or restore a Studio project, then rerun the delivery audit with project_id.",
            "endpoint": "/api/studio/projects",
            "targetId": target_id,
        }
    if action == "provide-route-params":
        return {
            "label": "Provide route parameters",
            "message": "Select a source media segment or provide the required route params, then rerun dispatch preview or coverage.",
            "endpoint": "/api/studio/dispatch-preview",
            "targetId": target_id,
        }
    if action == "wait-or-refresh":
        return {
            "label": "Wait or refresh evidence",
            "message": "Wait for adapter evidence, then refresh coverage, handoff snapshot, or the delivery audit.",
            "endpoint": "/api/studio/coverage",
            "targetId": target_id,
        }
    if action == "retry-or-inspect":
        return {
            "label": "Retry or inspect target",
            "message": "Inspect the latest job/evidence for this target, then retry the job or rerun dispatch when appropriate.",
            "endpoint": "/api/studio/jobs/{job_id}",
            "retryEndpoint": "/api/studio/jobs/{job_id}/retry",
            "targetId": target_id,
        }
    if action == "restore-readiness":
        return {
            "label": "Restore dispatch readiness",
            "message": "Inspect the page auth, route params, and dispatch matrix entry, then restore the missing readiness prerequisite.",
            "endpoint": "/api/studio/dispatch-matrix",
            "targetId": target_id,
        }
    if action == "inspect-dispatch-matrix":
        return {
            "label": "Inspect dispatch matrix",
            "message": "Open the dispatch matrix and check auth status, missing route params, executor, and recommended action.",
            "endpoint": "/api/studio/dispatch-matrix",
            "targetId": target_id,
        }
    if action == "inspect-requirement":
        return {
            "label": "Inspect delivery requirement",
            "message": "Inspect the named readiness or audit requirement and resolve the reported gate before retrying handoff.",
            "endpoint": "/api/studio/delivery-audit",
            "targetId": target_id,
        }
    if action == "inspect-gap":
        if session_id:
            return {
                "label": "Inspect dispatch target",
                "message": "Open the dispatch session and review the target evidence before deciding whether to retry, skip, or keep it blocked.",
                "endpoint": "/api/studio/dispatch-sessions/{session_id}",
                "uiUrl": dispatch_session_ui_url(session_id, target_id),
                "query": {"target_id": target_id},
                "targetId": target_id,
                "sessionId": session_id,
            }
        return {
            "label": "Inspect handoff gap",
            "message": "Inspect the handoff snapshot gap and related coverage evidence before retrying the target.",
            "endpoint": "/api/studio/handoff-snapshot",
            "targetId": target_id,
        }
    if action == "retry-queue":
        if session_id:
            return {
                "label": "Retry dispatch queue",
                "message": "Retry this dispatch session to reopen cancelled or errored targets, then continue from the next pending target.",
                "endpoint": "/api/studio/dispatch-sessions/{session_id}",
                "retryEndpoint": "/api/studio/dispatch-sessions/{session_id}/retry",
                "uiUrl": dispatch_session_ui_url(session_id, target_id),
                "query": {"target_id": target_id},
                "targetId": target_id,
                "sessionId": session_id,
            }
        return {
            "label": "Retry dispatch queue",
            "message": "Open the related dispatch session and retry cancelled or errored targets.",
            "endpoint": "/api/studio/dispatch-sessions/{session_id}",
            "targetId": target_id,
        }
    if action == "wait-for-adapter":
        return {
            "label": "Wait for adapter",
            "message": "The adapter has not produced accepted evidence yet. Wait, refresh the job queue, or cancel if it is stale.",
            "endpoint": "/api/studio/jobs/{job_id}",
            "cancelEndpoint": "/api/studio/jobs/{job_id}/cancel",
            "targetId": target_id,
        }
    if action == "poll-result":
        return {
            "label": "Poll result",
            "message": "Refresh the job evidence and adapter result until a terminal state or accepted media is available.",
            "endpoint": "/api/studio/jobs/{job_id}/evidence",
            "targetId": target_id,
        }
    if action == "retry-or-cancel":
        return {
            "label": "Retry or cancel job",
            "message": "Retry the job if the adapter can run again, or cancel it to unblock the delivery queue.",
            "retryEndpoint": "/api/studio/jobs/{job_id}/retry",
            "cancelEndpoint": "/api/studio/jobs/{job_id}/cancel",
            "targetId": target_id,
        }
    if action == "inspect-error":
        return {
            "label": "Inspect job error",
            "message": "Open the job evidence trail, review the adapter error, then retry, cancel, or fix the adapter input.",
            "endpoint": "/api/studio/jobs/{job_id}/evidence",
            "targetId": target_id,
        }
    if action == "verify-evidence":
        return {
            "label": "Verify evidence",
            "message": "Confirm the job has accepted fresh media or explicit failure evidence before treating it as deliverable.",
            "endpoint": "/api/studio/jobs/{job_id}/evidence",
            "targetId": target_id,
        }
    return {
        "label": "Inspect Studio action",
        "message": "Inspect the related requirement, dispatch target, or job evidence before retrying.",
        "targetId": target_id,
    }

def action_with_operator_instruction(
    action: dict[str, Any],
    *,
    manual_actions: set[str],
) -> dict[str, Any]:
    action_name = str(action.get("action") or "")
    if action_name not in manual_actions and action_name != "retry-queue":
        return action

    target_id = str(
        action.get("targetId")
        or action.get("jobId")
        or action.get("segmentId")
        or action.get("pageId")
        or ""
    )
    if not target_id:
        return action

    session_id = str(action.get("sessionId") or "") or None
    next_instruction = materialize_operator_instruction(
        manual_action_instruction(action_name, target_id, session_id=session_id)
    )
    enriched = {**action, "next": next_instruction}
    for key in ("url", "retryUrl", "cancelUrl", "uiUrl"):
        if next_instruction.get(key) and not enriched.get(key):
            enriched[key] = next_instruction[key]
    return enriched

def manual_action_resolution(action: str, target_id: str, *, session_id: str | None = None) -> dict[str, Any]:
    return {
        "status": "manual_required",
        "action": action,
        "targetId": target_id,
        "sessionId": session_id,
        "resultType": "operator-instruction",
        "message": "Manual operator action is required.",
        "next": materialize_operator_instruction(
            manual_action_instruction(action, target_id, session_id=session_id)
        ),
    }

def coverage_verify_action_resolution(
    *,
    checked_at: str,
    action: str,
    target_id: str,
    project_id: str | None,
    source_segment_id: str | None,
    result: dict[str, Any],
    audit: dict[str, Any],
) -> dict[str, Any]:
    created_count = int(result.get("createdCount") or 0)
    return {
        "status": "executed" if created_count else "skipped",
        "checkedAt": checked_at,
        "action": action,
        "targetId": target_id,
        "projectId": result.get("projectId") or project_id,
        "sourceSegmentId": result.get("sourceSegmentId") or source_segment_id,
        "resultType": "coverage-verify",
        "message": f"Verified {created_count} ready target(s).",
        "result": result,
        "audit": audit,
    }

def dispatch_target_run_action_resolution(
    *,
    checked_at: str,
    action: str,
    target_id: str,
    session_id: str,
    project_id: str | None,
    source_segment_id: str | None,
    result: dict[str, Any],
    audit: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": "executed",
        "checkedAt": checked_at,
        "action": action,
        "targetId": target_id,
        "sessionId": session_id,
        "projectId": project_id,
        "sourceSegmentId": source_segment_id,
        "resultType": "dispatch-target-run",
        "message": f"Ran dispatch target {target_id}.",
        "result": result,
        "audit": audit,
    }

def dispatch_session_retry_action_resolution(
    *,
    checked_at: str,
    action: str,
    target_id: str,
    session_id: str,
    project_id: str | None,
    source_segment_id: str | None,
    session: dict[str, Any],
    audit: dict[str, Any],
) -> dict[str, Any]:
    pending = int((session.get("summary") or {}).get("pending") or 0)
    return {
        "status": "executed",
        "checkedAt": checked_at,
        "action": action,
        "targetId": target_id,
        "sessionId": session_id,
        "projectId": project_id,
        "sourceSegmentId": source_segment_id,
        "resultType": "dispatch-session-retry",
        "message": f"Retried dispatch session {session_id}; {pending} target(s) pending.",
        "result": {"session": session},
        "audit": audit,
    }

def missing_session_action_skip(action: str, target_id: str, result_type: str) -> dict[str, Any]:
    return {
        "status": "skipped",
        "action": action,
        "targetId": target_id,
        "resultType": result_type,
        "reason": "missing_session_id",
        "message": f"{action} requires session_id.",
    }

def unsupported_action_skip(action: str, target_id: str) -> dict[str, Any]:
    return {
        "status": "skipped",
        "action": action,
        "targetId": target_id,
        "resultType": "unsupported",
        "message": f"Unsupported Studio action: {action}",
    }

def classify_action_batch(
    normalized_actions: list[dict[str, Any]],
    *,
    manual_actions: set[str],
) -> dict[str, Any]:
    verify_page_ids: list[str] = []
    run_target_actions: list[dict[str, str]] = []
    retry_queue_actions: list[dict[str, str]] = []
    manual_resolutions: list[dict[str, Any]] = []
    skipped_actions: list[dict[str, Any]] = []

    for item in normalized_actions:
        action = item["action"]
        target_id = item["targetId"]
        session_id = item.get("sessionId") or ""
        if action == "verify-ready":
            verify_page_ids.append(target_id)
        elif action == "run-target":
            if session_id:
                run_target_actions.append({"targetId": target_id, "sessionId": session_id})
            else:
                skipped_actions.append(missing_session_action_skip(action, target_id, "dispatch-target-run"))
        elif action == "retry-queue":
            if session_id:
                retry_queue_actions.append({"targetId": target_id, "sessionId": session_id})
            else:
                skipped_actions.append(missing_session_action_skip(action, target_id, "dispatch-session-retry"))
        elif action in manual_actions:
            manual_resolutions.append(manual_action_resolution(action, target_id, session_id=session_id or None))
        else:
            skipped_actions.append(unsupported_action_skip(action, target_id))

    return {
        "verifyPageIds": verify_page_ids,
        "runTargetActions": run_target_actions,
        "retryQueueActions": retry_queue_actions,
        "manualActions": manual_resolutions,
        "skippedActions": skipped_actions,
    }

def coverage_verify_batch_actions(
    verify_page_ids: list[str],
    coverage_result: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    jobs_by_page = {job.get("pageId"): job for job in coverage_result.get("jobs") or []}
    skipped_by_page = {page.get("pageId"): page for page in coverage_result.get("skippedPages") or []}
    executed_actions: list[dict[str, Any]] = []
    skipped_actions: list[dict[str, Any]] = []
    for page_id in verify_page_ids:
        if page_id in jobs_by_page:
            executed_actions.append(
                {
                    "status": "executed",
                    "action": "verify-ready",
                    "targetId": page_id,
                    "resultType": "coverage-verify",
                    "jobId": jobs_by_page[page_id].get("jobId"),
                    "message": f"Verified {page_id}.",
                }
            )
        else:
            skipped = skipped_by_page.get(page_id) or {}
            skipped_actions.append(
                {
                    "status": "skipped",
                    "action": "verify-ready",
                    "targetId": page_id,
                    "resultType": "coverage-verify",
                    "reason": skipped.get("reason") or "not_verified",
                    "message": skipped.get("message") or "No verification job was created.",
                }
            )
    return executed_actions, skipped_actions

def action_http_skip(
    *,
    action: str,
    target_id: str,
    session_id: str,
    result_type: str,
    status_code: int,
    detail: Any,
) -> dict[str, Any]:
    return {
        "status": "skipped",
        "action": action,
        "targetId": target_id,
        "sessionId": session_id,
        "resultType": result_type,
        "reason": f"http_{status_code}",
        "message": str(detail),
    }

def dispatch_target_run_batch_action(
    *,
    target_id: str,
    session_id: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": "executed",
        "action": "run-target",
        "targetId": target_id,
        "sessionId": session_id,
        "resultType": "dispatch-target-run",
        "jobId": (result.get("job") or {}).get("jobId"),
        "message": f"Ran dispatch target {target_id}.",
        "result": result,
    }

def dispatch_session_retry_batch_action(
    *,
    target_id: str,
    session_id: str,
    session: dict[str, Any],
) -> dict[str, Any]:
    pending = int((session.get("summary") or {}).get("pending") or 0)
    return {
        "status": "executed",
        "action": "retry-queue",
        "targetId": target_id,
        "sessionId": session_id,
        "resultType": "dispatch-session-retry",
        "message": f"Retried dispatch session {session_id}; {pending} target(s) pending.",
        "result": {"session": session},
    }

def action_batch_status(
    *,
    executed_actions: list[dict[str, Any]],
    manual_actions: list[dict[str, Any]],
    skipped_actions: list[dict[str, Any]],
) -> str:
    if manual_actions and executed_actions:
        return "executed_with_manual"
    if manual_actions and not executed_actions:
        return "manual_required"
    if skipped_actions and not executed_actions:
        return "skipped"
    if skipped_actions:
        return "executed_with_skips"
    return "executed"

def action_batch_response(
    *,
    checked_at: str,
    requested_count: int,
    project_id: str | None,
    source_segment_id: str | None,
    executed_actions: list[dict[str, Any]],
    manual_actions: list[dict[str, Any]],
    skipped_actions: list[dict[str, Any]],
    created_jobs: int,
    result: dict[str, Any] | None,
    audit: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": action_batch_status(
            executed_actions=executed_actions,
            manual_actions=manual_actions,
            skipped_actions=skipped_actions,
        ),
        "checkedAt": checked_at,
        "projectId": project_id,
        "sourceSegmentId": source_segment_id,
        "summary": {
            "requested": requested_count,
            "executed": len(executed_actions),
            "manualRequired": len(manual_actions),
            "skipped": len(skipped_actions),
            "createdJobs": created_jobs,
        },
        "executedActions": executed_actions,
        "manualActions": manual_actions,
        "skippedActions": skipped_actions,
        "result": result,
        "audit": audit,
    }
