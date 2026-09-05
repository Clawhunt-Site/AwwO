from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from studio_app.application.policies import dispatch as dispatch_rules


@dataclass(frozen=True)
class StudioDeliveryRouterDeps:
    dispatch_matrix: Callable[..., dict[str, Any]]
    studio_coverage: Callable[..., dict[str, Any]]
    verify_studio_coverage: Callable[..., dict[str, Any]]
    resolve_studio_action: Callable[[dict[str, Any] | None], Awaitable[dict[str, Any]]]
    resolve_studio_actions_batch: Callable[[dict[str, Any] | None], Awaitable[dict[str, Any]]]
    studio_handoff_snapshot: Callable[..., Awaitable[dict[str, Any]]]
    studio_readiness: Callable[[], Awaitable[dict[str, Any]]]
    studio_delivery_audit: Callable[..., Awaitable[dict[str, Any]]]
    dispatch_preview: Callable[..., Awaitable[dict[str, Any]]]


def _payload_page_ids(value: Any) -> list[str]:
    try:
        return dispatch_rules.payload_page_ids(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _payload_limited_int(value: Any, *, default: int) -> int:
    return dispatch_rules.payload_limited_int(value, default=default, minimum=1, maximum=100)


def build_studio_delivery_router(deps: StudioDeliveryRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/dispatch-matrix")
    async def get_studio_dispatch_matrix(
        project_id: str | None = Query(None),
        source_segment_id: str | None = Query(None),
    ):
        return deps.dispatch_matrix(project_id=project_id, source_segment_id=source_segment_id)

    @router.get("/api/studio/coverage")
    async def get_studio_coverage(
        project_id: str | None = Query(None),
        source_segment_id: str | None = Query(None),
    ):
        return deps.studio_coverage(project_id=project_id, source_segment_id=source_segment_id)

    @router.post("/api/studio/coverage/verify")
    async def post_studio_coverage_verify(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        page_ids = _payload_page_ids(body.get("page_ids") or body.get("pageIds"))
        return deps.verify_studio_coverage(
            project_id=body.get("project_id") or body.get("projectId"),
            source_segment_id=body.get("source_segment_id") or body.get("sourceSegmentId"),
            page_ids=page_ids,
            limit=_payload_limited_int(body.get("limit"), default=50),
        )

    @router.post("/api/studio/actions/resolve")
    async def post_studio_action_resolve(payload: dict[str, Any] | None = Body(None)):
        return await deps.resolve_studio_action(payload)

    @router.post("/api/studio/actions/resolve-batch")
    async def post_studio_actions_resolve_batch(payload: dict[str, Any] | None = Body(None)):
        return await deps.resolve_studio_actions_batch(payload)

    @router.get("/api/studio/handoff-snapshot")
    async def get_studio_handoff_snapshot(
        project_id: str | None = Query(None),
        source_segment_id: str | None = Query(None),
    ):
        return await deps.studio_handoff_snapshot(project_id=project_id, source_segment_id=source_segment_id)

    @router.get("/api/studio/readiness")
    async def get_studio_readiness():
        return await deps.studio_readiness()

    @router.get("/api/studio/delivery-audit")
    async def get_studio_delivery_audit(
        project_id: str | None = Query(None),
        source_segment_id: str | None = Query(None),
        download: bool = Query(False),
    ):
        audit = await deps.studio_delivery_audit(project_id=project_id, source_segment_id=source_segment_id)
        if download:
            audit_project_id = audit.get("projectId") or project_id or "current"
            return JSONResponse(
                audit,
                headers={
                    "Content-Disposition": f'attachment; filename="myshell-studio-audit-{audit_project_id}.json"',
                },
            )
        return audit

    @router.get("/api/studio/dispatch-preview")
    async def get_dispatch_preview(
        message: str = Query(""),
        project_id: str | None = Query(None),
        action: str = Query("generate"),
        source_segment_id: str | None = Query(None),
        page_id: str = Query("dreamy-miniapp"),
        agent_id: str | None = Query(None),
        has_image: bool = Query(False),
        bot_id: str | None = Query(None),
        bot_slug: str | None = Query(None),
        bot_name: str | None = Query(None),
        bot_type: str | None = Query(None),
        article_id: str | None = Query(None),
    ):
        return await deps.dispatch_preview(
            message=message,
            action=action,
            page_id=page_id,
            agent_id=agent_id,
            project_id=project_id,
            source_segment_id=source_segment_id,
            has_image=has_image,
            bot_id=bot_id,
            bot_slug=bot_slug,
            bot_name=bot_name,
            bot_type=bot_type,
            article_id=article_id,
        )

    return router
