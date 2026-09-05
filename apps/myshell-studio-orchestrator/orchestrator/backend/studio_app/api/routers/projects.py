from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from studio_app.ports.repositories import StudioStore


@dataclass(frozen=True)
class StudioProjectsRouterDeps:
    store: Callable[[], StudioStore]
    job_with_evidence: Callable[[dict[str, Any]], dict[str, Any] | None]
    get_project: Callable[[str], dict[str, Any] | None]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    project_delivery_report: Callable[[dict[str, Any]], dict[str, Any]]
    project_delivery_bundle: Callable[..., Awaitable[dict[str, Any]]]
    create_timeline_export: Callable[..., dict[str, Any]]
    apply_client_result: Callable[[str, dict[str, Any]], dict[str, Any]]
    reset_project: Callable[[str], dict[str, Any]]


def _get_project_or_404(deps: StudioProjectsRouterDeps, project_id: str) -> dict[str, Any]:
    project = deps.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _job_view(deps: StudioProjectsRouterDeps, job: dict[str, Any]) -> dict[str, Any]:
    return deps.job_with_evidence(job) or job


def build_studio_projects_router(deps: StudioProjectsRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/projects")
    async def list_studio_projects(limit: int = Query(50, ge=1, le=200)):
        projects = deps.store().list_projects(limit=limit)
        for project in projects:
            project["jobs"] = [_job_view(deps, job) for job in deps.store().list_jobs(project["projectId"])]
        return {"projects": projects, "count": len(projects)}

    @router.get("/api/studio/projects/{project_id}")
    async def get_studio_project(project_id: str):
        project = _get_project_or_404(deps, project_id)
        deps.sync_project_jobs(project)
        return project

    @router.get("/api/studio/projects/{project_id}/delivery-report")
    async def get_studio_project_delivery_report(project_id: str):
        return deps.project_delivery_report(_get_project_or_404(deps, project_id))

    @router.get("/api/studio/projects/{project_id}/delivery-bundle")
    async def get_studio_project_delivery_bundle(
        project_id: str,
        source_segment_id: str | None = Query(None),
        download: bool = Query(False),
    ):
        bundle = await deps.project_delivery_bundle(_get_project_or_404(deps, project_id), source_segment_id=source_segment_id)
        if download:
            return JSONResponse(
                bundle,
                headers={
                    "Content-Disposition": f'attachment; filename="myshell-studio-delivery-{project_id}.json"',
                },
            )
        return bundle

    @router.get("/api/studio/projects/{project_id}/timeline-exports")
    async def list_studio_timeline_exports(project_id: str):
        project = _get_project_or_404(deps, project_id)
        exports = project.get("timelineExports") or []
        return {"projectId": project_id, "exports": exports, "count": len(exports)}

    @router.post("/api/studio/projects/{project_id}/timeline-export")
    async def create_studio_timeline_export(project_id: str, payload: dict[str, Any] = Body(default_factory=dict)):
        project = _get_project_or_404(deps, project_id)
        segment_ids = payload.get("segmentIds") if isinstance(payload, dict) else None
        if segment_ids is not None and not isinstance(segment_ids, list):
            raise HTTPException(status_code=400, detail="segmentIds must be a list")
        return deps.create_timeline_export(
            project,
            segment_ids=[str(item) for item in segment_ids] if segment_ids else None,
        )

    @router.post("/api/studio/projects/{project_id}/client-result")
    async def post_studio_client_result(project_id: str, payload: dict[str, Any] = Body(...)):
        return deps.apply_client_result(project_id, payload)

    @router.post("/api/studio/projects/{project_id}/reset")
    async def reset_studio_project(project_id: str):
        return deps.reset_project(project_id)

    return router
