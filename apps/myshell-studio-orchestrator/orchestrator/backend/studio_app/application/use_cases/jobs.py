from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.state import project as project_state


@dataclass(frozen=True)
class JobLifecycleDeps:
    evidence: Callable[..., dict[str, Any]]
    update_job: Callable[..., dict[str, Any]]
    get_project: Callable[[str], dict[str, Any] | None]
    now_iso: Callable[[], str]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    build_execution_request: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


def cancel_job_record(job: dict[str, Any], *, deps: JobLifecycleDeps) -> tuple[dict[str, Any], dict[str, Any] | None]:
    evidence = deps.evidence("cancelled", job.get("pageId", "studio"), message="Cancelled by Studio operator.")
    updated_job = deps.update_job(
        job,
        **project_state.cancel_job_patch(evidence),
    )
    project = deps.get_project(updated_job["projectId"])
    if project:
        project_state.sync_segment_from_job_status(
            project,
            updated_job,
            updated_at=updated_job.get("updatedAt") or deps.now_iso(),
        )
        deps.sync_project_jobs(project)
    return updated_job, project


def retry_job_record(
    job: dict[str, Any],
    *,
    deps: JobLifecycleDeps,
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    evidence = deps.evidence("queued", job.get("pageId", "studio"), message="Retry queued; waiting for adapter execution.")
    updated_job = deps.update_job(
        job,
        **project_state.retry_job_patch(job, evidence),
    )
    project = deps.get_project(updated_job["projectId"])
    if project:
        project_state.sync_segment_from_job_status(
            project,
            updated_job,
            updated_at=updated_job.get("updatedAt") or deps.now_iso(),
        )
        execution_request = deps.build_execution_request(project, updated_job)
        deps.sync_project_jobs(project)
    else:
        execution_request = None
    return updated_job, project, execution_request
