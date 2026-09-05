from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

from studio_app.application.policies import dispatch as dispatch_rules
from studio_app.ports.repositories import StudioStore


@dataclass(frozen=True)
class StudioDispatchSessionsRouterDeps:
    store: Callable[[], StudioStore]
    dispatch_batch_plan: Callable[..., Awaitable[dict[str, Any]]]
    create_dispatch_session: Callable[..., Awaitable[dict[str, Any]]]
    dispatch_session_view: Callable[[dict[str, Any]], dict[str, Any]]
    get_dispatch_session_or_404: Callable[[str], dict[str, Any]]
    dispatch_session_with_focused_target: Callable[[dict[str, Any], str | None], dict[str, Any]]
    cancel_dispatch_session: Callable[[str], dict[str, Any]]
    retry_dispatch_session: Callable[[str], dict[str, Any]]
    run_dispatch_session_target: Callable[[str, str], dict[str, Any]]
    update_dispatch_session_target: Callable[..., dict[str, Any]]


def _payload_page_ids(value: Any) -> list[str]:
    try:
        return dispatch_rules.payload_page_ids(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _payload_limited_int(value: Any, *, default: int) -> int:
    return dispatch_rules.payload_limited_int(value, default=default, minimum=1, maximum=100)


def build_studio_dispatch_sessions_router(deps: StudioDispatchSessionsRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.post("/api/studio/dispatch-batch")
    async def post_studio_dispatch_batch(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        page_ids = _payload_page_ids(body.get("page_ids") or body.get("pageIds"))
        return await deps.dispatch_batch_plan(
            project_id=body.get("project_id") or body.get("projectId"),
            source_segment_id=body.get("source_segment_id") or body.get("sourceSegmentId"),
            page_ids=page_ids,
            limit=_payload_limited_int(body.get("limit"), default=50),
            exclude_covered=dispatch_rules.payload_bool(body.get("exclude_covered", body.get("excludeCovered", False))),
        )

    @router.post("/api/studio/dispatch-sessions")
    async def post_studio_dispatch_session(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        page_ids = _payload_page_ids(body.get("page_ids") or body.get("pageIds"))
        return await deps.create_dispatch_session(
            project_id=body.get("project_id") or body.get("projectId"),
            source_segment_id=body.get("source_segment_id") or body.get("sourceSegmentId"),
            page_ids=page_ids,
            limit=_payload_limited_int(body.get("limit"), default=50),
            exclude_covered=dispatch_rules.payload_bool(body.get("exclude_covered", body.get("excludeCovered", False))),
        )

    @router.get("/api/studio/dispatch-sessions")
    async def list_studio_dispatch_sessions(
        project_id: str | None = Query(None),
        limit: int = Query(20, ge=1, le=200),
    ):
        sessions = [
            deps.dispatch_session_view(session)
            for session in deps.store().list_dispatch_sessions(project_id=project_id, limit=limit)
        ]
        return {"sessions": sessions, "count": len(sessions)}

    @router.get("/api/studio/dispatch-sessions/{session_id}")
    async def get_studio_dispatch_session(
        session_id: str,
        target_id: str | None = Query(None),
    ):
        return deps.dispatch_session_with_focused_target(deps.get_dispatch_session_or_404(session_id), target_id)

    @router.post("/api/studio/dispatch-sessions/{session_id}/cancel")
    async def cancel_studio_dispatch_session(session_id: str):
        return deps.cancel_dispatch_session(session_id)

    @router.post("/api/studio/dispatch-sessions/{session_id}/retry")
    async def retry_studio_dispatch_session(session_id: str):
        return deps.retry_dispatch_session(session_id)

    @router.post("/api/studio/dispatch-sessions/{session_id}/targets/{target_id}/run")
    async def run_studio_dispatch_session_target(session_id: str, target_id: str):
        return deps.run_dispatch_session_target(session_id, target_id)

    @router.post("/api/studio/dispatch-sessions/{session_id}/targets/{target_id}")
    async def update_studio_dispatch_session_target(
        session_id: str,
        target_id: str,
        payload: dict[str, Any] = Body(...),
    ):
        evidence = payload.get("evidence") if isinstance(payload.get("evidence"), dict) else {}
        return deps.update_dispatch_session_target(
            session_id,
            target_id,
            status=str(payload.get("status") or ""),
            evidence=evidence,
        )

    return router
