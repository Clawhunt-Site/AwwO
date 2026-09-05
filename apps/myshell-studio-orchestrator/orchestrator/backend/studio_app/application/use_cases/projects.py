from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules
from studio_app.application.services import execution_requests
from studio_app.application.state import project as project_state
from studio_app.ports.repositories import StudioStore


@dataclass(frozen=True)
class ProjectUseCaseDeps:
    projects_cache: dict[str, dict[str, Any]]
    store: StudioStore
    valid_modes: set[str]
    status_count_keys: tuple[str, ...]
    pending_delivery_statuses: set[str]
    issue_delivery_statuses: set[str]
    placeholder_posters: dict[str, str]
    verified_workshop_project_id: str
    verified_workshop_segments: list[dict[str, Any]]
    now_iso: Callable[[], str]
    make_id: Callable[[str], str]
    adapter_auth_status: Callable[[str], dict[str, Any]]
    get_page: Callable[[str], dict[str, Any]]
    get_bot_by_slug: Callable[[str], dict[str, Any] | None]
    get_dreamy_bot_by_slug: Callable[[str], dict[str, Any] | None]
    navigation_contract: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], dict[str, Any]]
    missing_route_params: Callable[[dict[str, Any], str], list[str]]
    agent_id_for_dispatch: Callable[[dict[str, Any], str | None], str]
    agent_id_for_page: Callable[[dict[str, Any]], str]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    studio_coverage: Callable[..., dict[str, Any]]
    studio_handoff_snapshot: Callable[..., Awaitable[dict[str, Any]]]
    dispatch_session_view: Callable[[dict[str, Any]], dict[str, Any]]
    delivery_bundle_artifacts: Callable[[str, list[dict[str, Any]], str | None], list[dict[str, Any]]]


class ProjectUseCases:
    def __init__(self, deps: ProjectUseCaseDeps) -> None:
        self.deps = deps

    def normalize_mode(self, mode: str) -> str:
        return project_state.normalize_mode(mode, valid_modes=self.deps.valid_modes)

    def save_project(self, project: dict[str, Any]) -> None:
        self.deps.projects_cache[project["projectId"]] = project
        self.deps.store.save_project(project)

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        if project_id in self.deps.projects_cache:
            return self.deps.projects_cache[project_id]
        project = self.deps.store.get_project(project_id)
        if project:
            self.deps.projects_cache[project_id] = project
        return project

    def project(self, project_id: str | None = None, mode: str = "player") -> dict[str, Any]:
        if project_id and project_id in self.deps.projects_cache:
            project = self.deps.projects_cache[project_id]
            project["mode"] = self.normalize_mode(mode or project.get("mode", "player"))
            project["updatedAt"] = self.deps.now_iso()
            self.save_project(project)
            return project

        if project_id:
            stored = self.deps.store.get_project(project_id)
            if stored:
                stored["mode"] = self.normalize_mode(mode or stored.get("mode", "player"))
                stored["updatedAt"] = self.deps.now_iso()
                stored["jobs"] = self.deps.store.list_jobs(project_id)
                self.save_project(stored)
                return stored

        new_id = project_id or self.deps.make_id("project")
        project = project_state.new_project_payload(
            project_id=new_id,
            conversation_id=self.deps.make_id("conversation"),
            mode=self.normalize_mode(mode),
            updated_at=self.deps.now_iso(),
        )
        self.save_project(project)
        return project

    def verified_dreamy_workshop_project(self) -> dict[str, Any]:
        existing = self.get_project(self.deps.verified_workshop_project_id)
        timeline_exports = list(existing.get("timelineExports") or [])[:20] if existing else []
        checked_at = self.deps.now_iso()
        project = project_state.verified_dreamy_workshop_project_payload(
            project_id=self.deps.verified_workshop_project_id,
            segments=self.deps.verified_workshop_segments,
            timeline_exports=timeline_exports,
            checked_at=checked_at,
        )
        project["jobs"] = self.deps.store.list_jobs(project["projectId"])
        self.save_project(project)
        return project

    def job_with_evidence(self, job: dict[str, Any] | None) -> dict[str, Any] | None:
        return project_state.job_with_evidence(
            job,
            self.deps.store.list_evidence(job_id=job["jobId"]) if job else [],
        )

    def sync_project_jobs(self, project: dict[str, Any]) -> None:
        segment_order = {str(segment.get("id") or ""): index for index, segment in enumerate(project.get("segments", []))}
        jobs = [self.job_with_evidence(job) for job in self.deps.store.list_jobs(project["projectId"])]
        jobs.sort(key=lambda job: segment_order.get(str(job.get("segmentId") or ""), len(segment_order)))
        project["jobs"] = jobs
        self.save_project(project)

    def evidence(
        self,
        status: str,
        source: str,
        *,
        accepted: bool = False,
        message: str = "",
        media_url: str = "",
        task_id: str = "",
    ) -> dict[str, Any]:
        return project_state.evidence(
            status,
            source,
            checked_at=self.deps.now_iso(),
            accepted=accepted,
            message=message,
            media_url=media_url,
            task_id=task_id,
        )

    def project_delivery_report(self, project: dict[str, Any]) -> dict[str, Any]:
        self.sync_project_jobs(project)
        jobs = [self.job_with_evidence(job) for job in self.deps.store.list_jobs(project["projectId"])]
        status_counts = dispatch_rules.status_counts([job for job in jobs if job], status_keys=self.deps.status_count_keys)
        return project_state.project_delivery_report(
            project,
            jobs=jobs,
            status_counts=status_counts,
            checked_at=self.deps.now_iso(),
            pending_statuses=self.deps.pending_delivery_statuses,
            issue_statuses=self.deps.issue_delivery_statuses,
        )

    async def project_delivery_bundle(
        self,
        project: dict[str, Any],
        source_segment_id: str | None = None,
    ) -> dict[str, Any]:
        self.sync_project_jobs(project)
        project_id = project["projectId"]
        delivery_report = self.project_delivery_report(project)
        coverage = self.deps.studio_coverage(project_id=project_id, source_segment_id=source_segment_id)
        handoff = await self.deps.studio_handoff_snapshot(project_id=project_id, source_segment_id=source_segment_id)
        dispatch_sessions = [
            self.deps.dispatch_session_view(session)
            for session in self.deps.store.list_dispatch_sessions(project_id=project_id, limit=50)
        ]
        jobs = [self.job_with_evidence(job) for job in self.deps.store.list_jobs(project_id=project_id, limit=500)]
        artifacts = self.deps.delivery_bundle_artifacts(project_id, dispatch_sessions, coverage.get("sourceSegmentId"))
        return project_state.project_delivery_bundle(
            project,
            delivery_report=delivery_report,
            coverage=coverage,
            handoff=handoff,
            dispatch_sessions=dispatch_sessions,
            jobs=jobs,
            artifacts=artifacts,
            checked_at=self.deps.now_iso(),
        )

    def build_execution_request(self, project: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
        page = self.deps.get_page(job.get("pageId"))
        auth_status = self.deps.adapter_auth_status(page["id"])
        timestamp = self.deps.now_iso()
        segment = project_state.find_segment(project, job.get("segmentId")) or execution_requests.segment_from_job(
            job,
            auth_status=auth_status,
            created_at=timestamp,
            updated_at=timestamp,
        )
        bot = execution_requests.bot_from_job(
            job,
            segment,
            self.deps.get_dreamy_bot_by_slug(job.get("botSlug", "")) or self.deps.get_bot_by_slug(job.get("botSlug", "")),
        )
        source_segment = project_state.find_segment(project, segment.get("parentSegmentId"))
        route = execution_requests.route_from_job(job, page, segment, bot)
        graph = self.deps.set_graph_status(project, route, segment)
        contract = self.deps.navigation_contract(page, route, source_segment)
        return execution_requests.execution_request_from_job(
            job,
            page=page,
            segment=segment,
            source_segment=source_segment,
            graph=graph,
            contract=contract,
            missing_route_params=self.deps.missing_route_params(page, contract.get("navigationPath", "")),
            agent_id=job.get("agentId") or self.deps.agent_id_for_page(page),
            auth_status=auth_status,
        )

    def create_job(
        self,
        project: dict[str, Any],
        segment: dict[str, Any],
        route: dict[str, Any],
        page: dict[str, Any],
        source_segment: dict[str, Any] | None = None,
        status: str = "queued",
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        auth_status = self.deps.adapter_auth_status(page["id"])
        evidence = self.evidence(
            status,
            page["id"],
            accepted=False,
            message="Waiting for fresh adapter result; placeholders are not accepted as completion evidence.",
        )
        job = project_state.new_job_payload(
            project,
            segment,
            route,
            page,
            job_id=self.deps.make_id("job"),
            agent_id=self.deps.agent_id_for_dispatch(page, agent_id),
            auth_status=auth_status,
            evidence=evidence,
            navigation_contract=self.deps.navigation_contract(page, route, source_segment),
            created_at=self.deps.now_iso(),
            updated_at=self.deps.now_iso(),
            status=status,
        )
        segment["jobId"] = job["jobId"]
        segment["authStatus"] = auth_status
        segment["evidence"] = evidence
        self.deps.store.save_job(job)
        self.deps.store.save_evidence(job, evidence)
        self.sync_project_jobs(project)
        return job

    def update_job(self, job: dict[str, Any], **patch: Any) -> dict[str, Any]:
        job.update({key: value for key, value in patch.items() if value is not None})
        job["updatedAt"] = self.deps.now_iso()
        self.deps.store.save_job(job)
        if patch.get("evidence"):
            self.deps.store.save_evidence(job, patch["evidence"])
        return job

    def append_queued_segment(
        self,
        project: dict[str, Any],
        route: dict[str, Any],
        prompt: str,
        action: str,
        source_segment_id: str | None,
    ) -> dict[str, Any]:
        bot = route["bot"]
        timestamp = self.deps.now_iso()
        segment = project_state.queued_segment_payload(
            route,
            segment_id=self.deps.make_id("segment"),
            segment_type=project_state.segment_type_for_bot({"type": bot.get("type")}),
            prompt=prompt,
            action=action,
            source_segment_id=source_segment_id,
            poster_url=self.deps.placeholder_posters.get(action, self.deps.placeholder_posters["generate"]),
            evidence=self.evidence(
                "queued",
                "placeholder",
                message="Placeholder poster only; waiting for real adapter output.",
            ),
            created_at=timestamp,
            updated_at=timestamp,
        )
        project_state.append_segment(project, segment, updated_at=self.deps.now_iso())
        self.save_project(project)
        return segment
