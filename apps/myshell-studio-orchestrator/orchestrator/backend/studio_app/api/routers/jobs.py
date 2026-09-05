from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

from studio_app.application.state import project as project_state
from studio_app.ports.repositories import StudioStore
from studio_app.ports.task_runner import StudioTaskRunner


StudioProject = dict[str, Any]


@dataclass(frozen=True)
class StudioJobsRouterDeps:
    store: Callable[[], StudioStore]
    terminal_cancel_statuses: set[str]
    job_with_evidence: Callable[[dict[str, Any]], dict[str, Any] | None]
    cancel_job_record: Callable[[dict[str, Any]], tuple[dict[str, Any], StudioProject | None]]
    retry_job_record: Callable[[dict[str, Any]], tuple[dict[str, Any], StudioProject | None, dict[str, Any] | None]]
    poll_dreamy_job_result: Callable[[dict[str, Any]], Awaitable[tuple[dict[str, Any], StudioProject | None]]]
    task_runner: StudioTaskRunner


def _get_job_or_404(store: StudioStore, job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _job_view(deps: StudioJobsRouterDeps, job: dict[str, Any]) -> dict[str, Any]:
    return deps.job_with_evidence(job) or job


def build_studio_jobs_router(deps: StudioJobsRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/jobs")
    async def list_studio_jobs(
        project_id: str | None = Query(None),
        status: str | None = Query(None),
        page_id: str | None = Query(None),
        agent_id: str | None = Query(None),
        limit: int = Query(100, ge=1, le=500),
    ):
        jobs = deps.store().list_jobs(
            project_id=project_id,
            status=status,
            page_id=page_id,
            agent_id=agent_id,
            limit=limit,
        )
        return {"jobs": [_job_view(deps, job) for job in jobs], "count": len(jobs)}

    @router.post("/api/studio/jobs/bulk")
    async def bulk_studio_jobs(payload: dict[str, Any] = Body(...)):
        action = str(payload.get("action") or "").strip()
        if action not in {"cancel", "retry"}:
            raise HTTPException(status_code=400, detail="Bulk action must be cancel or retry")
        jobs = deps.store().list_jobs(
            project_id=payload.get("project_id"),
            status=payload.get("status"),
            page_id=payload.get("page_id"),
            agent_id=payload.get("agent_id"),
            limit=int(payload.get("limit") or 100),
        )
        include_terminal = bool(payload.get("include_terminal"))
        updated_jobs: list[dict[str, Any]] = []
        skipped_jobs: list[dict[str, Any]] = []
        projects_by_id: dict[str, StudioProject] = {}
        execution_requests: list[dict[str, Any]] = []
        for job in jobs:
            if project_state.should_skip_bulk_job_action(
                job,
                action=action,
                include_terminal=include_terminal,
                terminal_cancel_statuses=deps.terminal_cancel_statuses,
            ):
                skipped_jobs.append(_job_view(deps, job))
                continue
            if action == "cancel":
                updated_job, project = deps.cancel_job_record(job)
                execution_request = None
            else:
                updated_job, project, execution_request = deps.retry_job_record(job)
            updated_jobs.append(_job_view(deps, updated_job))
            if project:
                projects_by_id[project["projectId"]] = project
            if execution_request:
                execution_requests.append(execution_request)
        return project_state.bulk_job_action_response(
            action=action,
            updated_jobs=updated_jobs,
            skipped_jobs=skipped_jobs,
            projects_by_id=projects_by_id,
            execution_requests=execution_requests,
        )

    @router.get("/api/studio/jobs/{job_id}/evidence")
    async def get_studio_job_evidence(job_id: str):
        store = deps.store()
        _get_job_or_404(store, job_id)
        return {"jobId": job_id, "evidence": store.list_evidence(job_id=job_id)}

    @router.get("/api/studio/jobs/{job_id}")
    async def get_studio_job(job_id: str):
        return _job_view(deps, _get_job_or_404(deps.store(), job_id))

    @router.post("/api/studio/jobs/{job_id}/cancel")
    async def cancel_studio_job(job_id: str):
        job, project = deps.cancel_job_record(_get_job_or_404(deps.store(), job_id))
        return {"job": _job_view(deps, job), "project": project}

    @router.post("/api/studio/jobs/{job_id}/retry")
    async def retry_studio_job(job_id: str):
        job, project, execution_request = deps.retry_job_record(_get_job_or_404(deps.store(), job_id))
        return {"job": _job_view(deps, job), "project": project, "executionRequest": execution_request}

    @router.post("/api/studio/jobs/{job_id}/poll")
    async def poll_studio_job(job_id: str):
        existing_job = _get_job_or_404(deps.store(), job_id)
        job, project = await deps.task_runner.run(
            "poll_dreamy_job_result",
            lambda: deps.poll_dreamy_job_result(existing_job),
        )
        return {"job": _job_view(deps, job), "project": project}

    return router
