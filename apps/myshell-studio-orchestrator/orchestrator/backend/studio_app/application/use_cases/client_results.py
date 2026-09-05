from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.services import dreamy_jobs
from studio_app.application.state import project as project_state


class ProjectResultError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ClientResultDeps:
    get_project: Callable[[str], dict[str, Any] | None]
    find_segment: Callable[[dict[str, Any], str | None], dict[str, Any] | None]
    get_dreamy_bot_by_slug: Callable[[str], dict[str, Any] | None]
    get_bot_by_slug: Callable[[str], dict[str, Any] | None]
    make_id: Callable[[str], str]
    segment_type_for_bot: Callable[[dict[str, Any]], str]
    adapter_auth_status: Callable[[str], dict[str, Any]]
    now_iso: Callable[[], str]
    normalize_status: Callable[[str | None], str]
    evidence: Callable[..., dict[str, Any]]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    append_message: Callable[..., dict[str, Any]]
    get_job: Callable[[str], dict[str, Any] | None]
    find_job_by_segment: Callable[[str, str], dict[str, Any] | None]
    update_job: Callable[..., dict[str, Any]]
    update_dispatch_session_target: Callable[..., dict[str, Any]]
    sync_project_jobs: Callable[[dict[str, Any]], None]


def apply_client_result(project_id: str, payload: dict[str, Any], *, deps: ClientResultDeps) -> dict[str, Any]:
    project = deps.get_project(project_id)
    if not project:
        raise ProjectResultError(404, "Project not found")

    segment_id = payload.get("segmentId") or payload.get("id")
    segment = deps.find_segment(project, segment_id)
    if not segment:
        route_bot_slug = payload.get("botSlug") or "seedream-multi-chart"
        bot = deps.get_dreamy_bot_by_slug(route_bot_slug) or deps.get_bot_by_slug(route_bot_slug) or {
            "slug": route_bot_slug,
            "name": payload.get("botName") or route_bot_slug,
            "type": payload.get("type") or "text-to-image",
        }
        created_at = deps.now_iso()
        segment = project_state.new_client_result_segment(
            payload,
            segment_id=segment_id or deps.make_id("segment"),
            bot=bot,
            segment_type=deps.segment_type_for_bot(bot),
            auth_status=deps.adapter_auth_status("dreamy-miniapp"),
            created_at=created_at,
            updated_at=created_at,
        )
        project["segments"].append(segment)

    normalized_status = deps.normalize_status(payload.get("status"))
    source = payload.get("source") or "dreamy-miniapp"
    normalized_status, payload = project_state.client_result_status_payload(
        payload,
        normalized_status,
        missing_media_evidence=deps.evidence(
            "error",
            source,
            message="Done status rejected because no media URL was supplied.",
        ),
    )
    project_state.apply_client_result_payload(
        segment,
        payload,
        normalized_status=normalized_status,
        source=source,
        auth_status=deps.adapter_auth_status("dreamy-miniapp"),
        updated_at=deps.now_iso(),
    )
    project["selectedSegmentId"] = segment["id"]
    project["updatedAt"] = deps.now_iso()
    deps.set_graph_status(project, project_state.client_result_graph_route(segment), segment)
    deps.append_message(
        project,
        "assistant",
        project_state.client_result_assistant_message(segment),
        segmentId=segment["id"],
    )
    job = None
    job_id = segment.get("jobId") or payload.get("jobId")
    if job_id:
        job = deps.get_job(job_id)
    if not job:
        job = deps.find_job_by_segment(project_id, segment["id"])
    if job:
        segment["jobId"] = job["jobId"]
        job = deps.update_job(
            job,
            **project_state.client_result_job_patch(segment, normalized_status, job),
        )
    dispatch_update = dreamy_jobs.dispatch_target_update_from_client_result(payload, job, segment, normalized_status)
    if dispatch_update:
        deps.update_dispatch_session_target(
            dispatch_update["sessionId"],
            dispatch_update["targetId"],
            status=dispatch_update["status"],
            evidence=dispatch_update["evidence"],
        )
    deps.sync_project_jobs(project)
    return {"project": project, "segment": segment, "job": job}
