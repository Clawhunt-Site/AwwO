from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, Query
from fastapi.responses import StreamingResponse


@dataclass(frozen=True)
class StudioSuperClawRouterDeps:
    status: Callable[[], Awaitable[dict[str, Any]]]
    run_canvas_workflow: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    list_runs: Callable[[], Awaitable[dict[str, Any]]]
    get_run: Callable[[str], Awaitable[dict[str, Any]]]
    stream_run_events: Callable[[str], AsyncIterator[str]]
    cancel_run: Callable[[str], Awaitable[dict[str, Any]]]
    resume_run: Callable[[str], Awaitable[dict[str, Any]]]
    create_automation: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    list_automations: Callable[[str | None], Awaitable[list[dict[str, Any]]]]
    approve_automation: Callable[[str], Awaitable[dict[str, Any]]]
    delete_automation: Callable[[str], Awaitable[dict[str, Any]]]


def build_studio_superclaw_router(deps: StudioSuperClawRouterDeps) -> APIRouter:
    router = APIRouter(prefix="/api/studio/superclaw", tags=["studio-superclaw"])

    @router.get("/status")
    async def get_superclaw_status():
        return await deps.status()

    @router.post("/canvas/run")
    async def post_superclaw_canvas_run(payload: dict[str, Any] = Body(default_factory=dict)):
        return await deps.run_canvas_workflow(payload)

    @router.get("/runs")
    async def get_superclaw_runs():
        return await deps.list_runs()

    @router.get("/runs/{run_id}")
    async def get_superclaw_run(run_id: str):
        return await deps.get_run(run_id)

    @router.get("/runs/{run_id}/events")
    async def get_superclaw_run_events(run_id: str):
        return StreamingResponse(deps.stream_run_events(run_id), media_type="text/event-stream")

    @router.post("/runs/{run_id}/cancel")
    async def post_superclaw_run_cancel(run_id: str):
        return await deps.cancel_run(run_id)

    @router.post("/runs/{run_id}/resume")
    async def post_superclaw_run_resume(run_id: str):
        return await deps.resume_run(run_id)

    @router.post("/automations")
    async def post_superclaw_automation(payload: dict[str, Any] = Body(default_factory=dict)):
        return await deps.create_automation(payload)

    @router.get("/automations")
    async def get_superclaw_automations(session_issue_id: str | None = Query(None, alias="sessionIssueId")):
        return {"automations": await deps.list_automations(session_issue_id)}

    @router.post("/automations/{automation_id}/approve")
    async def post_superclaw_automation_approve(automation_id: str):
        return await deps.approve_automation(automation_id)

    @router.delete("/automations/{automation_id}")
    async def delete_superclaw_automation(automation_id: str):
        return await deps.delete_automation(automation_id)

    return router
