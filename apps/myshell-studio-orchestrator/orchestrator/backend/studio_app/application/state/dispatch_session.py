from __future__ import annotations

from typing import Any


def next_target(targets: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next(
        (
            target
            for target in targets
            if target.get("status", "pending") == "pending"
            and target.get("executor") == "navigation"
            and target.get("navigationPath")
        ),
        None,
    ) or next((target for target in targets if target.get("status", "pending") == "pending"), None)


def session_view(session: dict[str, Any]) -> dict[str, Any]:
    targets = session.get("targets") or []
    for target in targets:
        target.setdefault("status", "pending")
    completed = sum(1 for target in targets if target.get("status") == "completed")
    visited = sum(1 for target in targets if target.get("status") == "visited")
    pending = sum(1 for target in targets if target.get("status") == "pending")
    skipped_targets = sum(1 for target in targets if target.get("status") == "skipped")
    errors = sum(1 for target in targets if target.get("status") == "error")
    cancelled_targets = sum(1 for target in targets if target.get("status") == "cancelled")
    summary = dict(session.get("summary") or {})
    summary.update(
        {
            "pending": pending,
            "visited": visited,
            "completed": completed,
            "targetSkipped": skipped_targets,
            "targetErrors": errors,
            "targetCancelled": cancelled_targets,
        }
    )
    if not targets:
        status = "blocked"
    elif pending > 0:
        status = "active"
    elif visited > 0 or errors > 0:
        status = "needs_review"
    else:
        status = "done"

    view = dict(session)
    view["targets"] = targets
    view["summary"] = summary
    view["status"] = status if session.get("status") != "cancelled" else "cancelled"
    view["readyForDispatch"] = bool(targets) and view["status"] in {"active", "needs_review", "done"}
    view["nextTarget"] = None if view["status"] == "cancelled" else next_target(targets)
    return view


def with_focused_target(session: dict[str, Any], target_id: str | None = None) -> dict[str, Any]:
    view = dict(session)
    if not target_id:
        return view
    targets = view.get("targets") or []
    focused_index = next((index for index, target in enumerate(targets) if target.get("id") == target_id), -1)
    view["focusedTargetId"] = target_id
    view["focusedTargetIndex"] = focused_index
    view["focusedTarget"] = targets[focused_index] if focused_index >= 0 else None
    return view


def apply_target_status(
    target: dict[str, Any],
    *,
    status: str,
    now: str,
    evidence: dict[str, Any] | None = None,
) -> None:
    target["status"] = status
    target["updatedAt"] = now
    if status == "visited":
        target["visitedAt"] = now
    if status == "completed":
        target["completedAt"] = now
    if status == "skipped":
        target["skippedAt"] = now
    if status == "error":
        target["erroredAt"] = now
    current_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
    if evidence:
        target["evidence"] = {**current_evidence, **evidence}


def mark_navigation_target_visited(
    target: dict[str, Any],
    *,
    session_id: str,
    target_id: str,
    page: dict[str, Any],
    now: str,
) -> str:
    target_path = str(target.get("navigationPath") or "")
    current_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
    target["status"] = "visited"
    target["visitedAt"] = target.get("visitedAt") or now
    target["updatedAt"] = now
    target["evidence"] = {
        **current_evidence,
        "openedFrom": "studio-target-run",
        "dispatchSessionId": session_id,
        "dispatchTargetId": target_id,
        "pageId": page["id"],
        "navigationPath": target_path,
    }
    return target_path


def job_evidence_for_target(
    job: dict[str, Any],
    *,
    session_id: str,
    target_id: str,
    page: dict[str, Any],
) -> dict[str, Any]:
    return {
        **(job.get("evidence") or {}),
        "dispatchSessionId": session_id,
        "dispatchTargetId": target_id,
        "dispatchTargetPageId": page["id"],
    }


def mark_execution_target_visited(
    target: dict[str, Any],
    *,
    session_id: str,
    target_id: str,
    job: dict[str, Any],
    segment: dict[str, Any],
    now: str,
) -> None:
    current_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
    target["status"] = "visited"
    target["visitedAt"] = target.get("visitedAt") or now
    target["updatedAt"] = now
    target["jobId"] = job["jobId"]
    target["segmentId"] = segment["id"]
    target["evidence"] = {
        **current_evidence,
        "dispatchSessionId": session_id,
        "dispatchTargetId": target_id,
        "jobId": job["jobId"],
        "segmentId": segment["id"],
        "runFrom": "studio",
    }


def target_from_view(view: dict[str, Any], target_id: str) -> dict[str, Any] | None:
    return next((entry for entry in view.get("targets", []) if entry.get("id") == target_id), None)


def completion_coverage_page(target: dict[str, Any]) -> dict[str, Any]:
    return {
        "pageId": target["pageId"],
        "pageName": target.get("pageName") or target["pageId"],
        "agentId": target.get("agentId"),
    }


def completion_evidence_patch(
    session: dict[str, Any],
    target: dict[str, Any],
    operator_evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "coverageVerification": True,
        "dispatchSessionId": session["sessionId"],
        "dispatchTargetId": target["id"],
        "operatorEvidence": operator_evidence,
    }


def completion_message(target: dict[str, Any]) -> str:
    return f"Dispatch session marked {target.get('pageName') or target['pageId']} complete."


def attach_existing_evidence_job(target: dict[str, Any], existing_job: dict[str, Any] | None) -> None:
    if not existing_job:
        return
    target["jobId"] = existing_job["jobId"]
    target["evidence"] = {
        **(target.get("evidence") or {}),
        **(existing_job.get("evidence") or {}),
    }


def attach_completion_job(target: dict[str, Any], job: dict[str, Any]) -> None:
    target["evidenceJobId"] = job["jobId"]
    target["jobId"] = job["jobId"]
    target["evidence"] = {
        **(target.get("evidence") or {}),
        **(job.get("evidence") or {}),
    }


def cancel_session_targets(session: dict[str, Any], *, now: str) -> None:
    for target in session.get("targets", []):
        if target.get("status", "pending") not in {"pending", "visited"}:
            continue
        current_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
        target["status"] = "cancelled"
        target["cancelledAt"] = now
        target["updatedAt"] = now
        target["evidence"] = {
            **current_evidence,
            "cancelledFrom": "studio",
        }

    session["status"] = "cancelled"
    session["cancelledAt"] = now
    session["updatedAt"] = now


def retry_session_targets(session: dict[str, Any], *, now: str) -> int:
    reopened = 0
    for target in session.get("targets", []):
        previous_status = str(target.get("status") or "pending")
        if previous_status not in {"cancelled", "error"}:
            continue
        current_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
        target["status"] = "pending"
        target["retriedAt"] = now
        target["updatedAt"] = now
        target["evidence"] = {
            **current_evidence,
            "retriedFrom": previous_status,
            "retriedAt": now,
        }
        reopened += 1

    if reopened:
        session["status"] = "active"
        session["retriedAt"] = now
        session["retryCount"] = int(session.get("retryCount") or 0) + 1
        session["updatedAt"] = now
    return reopened
