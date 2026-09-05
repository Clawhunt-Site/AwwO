from __future__ import annotations

from typing import Any, Callable


StudioProject = dict[str, Any]
StudioSegment = dict[str, Any]
EvidenceFactory = Callable[..., dict[str, Any]]


def format_exception_message(exc: Exception) -> str:
    message = str(exc).strip()
    return message or exc.__class__.__name__


def timeline_segment_manifest(segment: StudioSegment, index: int) -> dict[str, Any]:
    duration_seconds = int(segment.get("durationSeconds") or segment.get("duration") or 5)
    return {
        "index": index,
        "segmentId": segment.get("id") or "",
        "type": segment.get("type") or "image",
        "status": segment.get("status") or "",
        "prompt": segment.get("prompt") or "",
        "action": segment.get("action") or "",
        "botId": segment.get("botId") or "",
        "botName": segment.get("botName") or "",
        "botSlug": segment.get("botSlug") or "",
        "taskId": segment.get("taskId") or "",
        "mediaUrl": segment.get("url") or "",
        "posterUrl": segment.get("posterUrl") or "",
        "durationSeconds": duration_seconds,
        "evidence": segment.get("evidence") or {},
    }


def timeline_export_manifest(
    project: StudioProject,
    segment_ids: list[str] | None = None,
    *,
    now_iso: Callable[[], str],
) -> dict[str, Any]:
    allowed_ids = set(segment_ids or [])
    source_segments = [
        segment
        for segment in project.get("segments", [])
        if not allowed_ids or str(segment.get("id") or "") in allowed_ids
    ]
    segments = [timeline_segment_manifest(segment, index + 1) for index, segment in enumerate(source_segments)]
    video_segments = [segment for segment in segments if segment.get("type") == "video" and segment.get("mediaUrl")]
    ready_segments = [segment for segment in segments if segment.get("mediaUrl") or segment.get("posterUrl")]
    return {
        "kind": "dreamy-long-video-sequence",
        "projectId": project.get("projectId") or "",
        "conversationId": project.get("conversationId") or "",
        "createdAt": now_iso(),
        "segments": segments,
        "summary": {
            "totalSegments": len(segments),
            "readySegments": len(ready_segments),
            "videoSegments": len(video_segments),
            "estimatedDurationSeconds": sum(int(segment.get("durationSeconds") or 5) for segment in segments),
        },
    }


def compose_timeline_manifest(export_id: str, video_segments: list[dict[str, Any]]) -> dict[str, Any]:
    if not video_segments:
        return {"status": "needs_media", "message": "No video segments are ready to compose."}
    return {"status": "manifest_ready", "message": "Timeline manifest is ready."}


def create_timeline_export(
    project: StudioProject,
    segment_ids: list[str] | None = None,
    *,
    make_id: Callable[[str], str],
    now_iso: Callable[[], str],
    evidence_factory: EvidenceFactory,
    save_project: Callable[[StudioProject], None],
    compose_video: Callable[[str, list[dict[str, Any]]], dict[str, Any]] = compose_timeline_manifest,
    exception_message: Callable[[Exception], str] = format_exception_message,
) -> dict[str, Any]:
    export_id = make_id("timeline_export")
    manifest = timeline_export_manifest(project, segment_ids, now_iso=now_iso)
    video_segments = [segment for segment in manifest["segments"] if segment.get("type") == "video" and segment.get("mediaUrl")]
    try:
        compose_result = compose_video(export_id, video_segments)
    except Exception as error:
        compose_result = {
            "status": "manifest_ready",
            "message": f"Video compose skipped: {type(error).__name__}: {exception_message(error)}",
        }

    status = compose_result.get("status") or ("needs_media" if not video_segments else "manifest_ready")
    media_url = compose_result.get("mediaUrl") or ""
    evidence = evidence_factory(
        status,
        "timeline-export",
        accepted=status == "ready" and bool(media_url),
        media_url=media_url,
        task_id=export_id,
        message=compose_result.get("message") or "Timeline manifest is ready.",
    )
    summary = manifest["summary"]
    export = {
        "exportId": export_id,
        "projectId": project["projectId"],
        "conversationId": project.get("conversationId") or "",
        "status": status,
        "checkedAt": evidence["checkedAt"],
        "mediaUrl": media_url,
        "manifest": manifest,
        "summary": summary,
        "videoSegments": summary.get("videoSegments", 0),
        "estimatedDurationSeconds": summary.get("estimatedDurationSeconds", 0),
        "evidence": evidence,
    }
    exports = project.setdefault("timelineExports", [])
    exports.insert(0, export)
    del exports[20:]
    project["updatedAt"] = now_iso()
    save_project(project)
    return export
