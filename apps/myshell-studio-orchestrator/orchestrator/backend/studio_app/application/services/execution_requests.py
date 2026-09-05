from __future__ import annotations

from typing import Any
from urllib.parse import quote


def segment_from_job(
    job: dict[str, Any],
    *,
    auth_status: dict[str, Any],
    created_at: str,
    updated_at: str,
) -> dict[str, Any]:
    return {
        "id": job.get("segmentId"),
        "type": "video" if job.get("botType") == "image-to-video" else "image",
        "url": job.get("mediaUrl", ""),
        "posterUrl": job.get("posterUrl", ""),
        "prompt": job.get("prompt", ""),
        "botId": job.get("botId", ""),
        "articleId": job.get("articleId", ""),
        "botSlug": job.get("botSlug", ""),
        "botName": job.get("botName", ""),
        "action": job.get("action", "generate"),
        "parentSegmentId": None,
        "status": job.get("status", "queued"),
        "taskId": job.get("taskId", ""),
        "jobId": job.get("jobId", ""),
        "authStatus": job.get("authStatus") or auth_status,
        "evidence": job.get("evidence") or {},
        "createdAt": job.get("createdAt", created_at),
        "updatedAt": job.get("updatedAt", updated_at),
    }


def bot_from_job(job: dict[str, Any], segment: dict[str, Any], bot: dict[str, Any] | None) -> dict[str, Any]:
    return bot or {
        "id": job.get("botId", ""),
        "slug": job.get("botSlug", ""),
        "name": job.get("botName", ""),
        "type": job.get("botType", segment.get("type", "image")),
        "articleId": job.get("articleId", ""),
        "rating": 4.5,
        "desc": "",
    }


def route_from_job(
    job: dict[str, Any],
    page: dict[str, Any],
    segment: dict[str, Any],
    bot: dict[str, Any],
) -> dict[str, Any]:
    bot_slug = str(bot.get("slug") or job.get("botSlug") or "")
    return {
        "bot": {
            "id": bot.get("id") or job.get("botId", ""),
            "slug": bot.get("slug") or job.get("botSlug"),
            "name": bot.get("name") or job.get("botName"),
            "type": bot.get("type") or job.get("botType"),
            "articleId": bot.get("articleId") or job.get("articleId", ""),
            "rating": bot.get("rating", 4.5),
            "description": bot.get("desc", ""),
            "pageUrl": (
                f"/bot?slug_id={quote(bot_slug)}"
                if page["id"] == "dreamy-miniapp"
                else f"https://art.myshell.ai/creative/{bot_slug}"
            ),
        },
        "executor": page["executor"],
        "analysis": "Retry queued from persisted Studio job.",
        "sourceSummary": f"Using segment {segment.get('parentSegmentId')}" if segment.get("parentSegmentId") else "Retrying original prompt",
    }


def execution_request_from_job(
    job: dict[str, Any],
    *,
    page: dict[str, Any],
    segment: dict[str, Any],
    source_segment: dict[str, Any] | None,
    graph: list[dict[str, Any]],
    contract: dict[str, Any],
    missing_route_params: list[str],
    agent_id: str,
    auth_status: dict[str, Any],
) -> dict[str, Any]:
    evidence = job.get("evidence") or {}
    request = {
        "executor": page["executor"],
        "api": page["id"],
        "page": page,
        "agentId": agent_id,
        **contract,
        "routeParams": page.get("routeParams") or [],
        "missingRouteParams": missing_route_params,
        "jobId": job["jobId"],
        "segmentId": job["segmentId"],
        "botId": job.get("botId", ""),
        "articleId": job.get("articleId", ""),
        "botSlug": job.get("botSlug", ""),
        "botName": job.get("botName", ""),
        "botType": job.get("botType", ""),
        "prompt": job.get("prompt", ""),
        "action": job.get("action", "generate"),
        "sourceSegment": source_segment,
        "agentGraph": graph,
        "segment": segment,
        "authStatus": job.get("authStatus") or auth_status,
        "evidence": evidence,
    }
    if evidence.get("dispatchSessionId"):
        request["dispatchSessionId"] = evidence.get("dispatchSessionId")
    if evidence.get("dispatchTargetId"):
        request["dispatchTargetId"] = evidence.get("dispatchTargetId")
    return request


def execution_request_from_route(
    route: dict[str, Any],
    page: dict[str, Any],
    job: dict[str, Any],
    segment: dict[str, Any],
    *,
    prompt: str,
    action: str,
    source_segment: dict[str, Any] | None,
    graph: list[dict[str, Any]],
    contract: dict[str, Any],
    missing_route_params: list[str],
) -> dict[str, Any]:
    bot = route["bot"]
    return {
        "executor": route["executor"],
        "api": page["id"],
        "page": page,
        "agentId": job["agentId"],
        **contract,
        "routeParams": page.get("routeParams") or [],
        "missingRouteParams": missing_route_params,
        "jobId": job["jobId"],
        "segmentId": segment["id"],
        "botId": bot.get("id") or "",
        "articleId": bot.get("articleId") or "",
        "botSlug": bot["slug"],
        "botName": bot["name"],
        "botType": bot["type"],
        "prompt": prompt,
        "action": action,
        "sourceSegment": source_segment,
        "agentGraph": graph,
        "segment": segment,
        "authStatus": job["authStatus"],
        "evidence": job["evidence"],
    }
