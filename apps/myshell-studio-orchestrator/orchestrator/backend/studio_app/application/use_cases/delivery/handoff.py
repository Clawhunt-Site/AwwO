from __future__ import annotations

from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules
from studio_app.application.policies.handoff import artifacts as handoff_artifacts
from studio_app.application.policies.handoff import audit as handoff_audit
from studio_app.application.policies.handoff import readiness as handoff_readiness
from studio_app.application.policies.handoff import snapshot as handoff_snapshot

from .errors import StudioDeliveryError


class StudioDeliveryHandoffMixin:

    def handoff_gaps_and_actions(
        self,
        coverage: dict[str, Any],
        delivery_report: dict[str, Any] | None,
        project_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        dispatch_sessions = (
            [
                self.dispatch_session_view(session)
                for session in self.deps.store.list_dispatch_sessions(project_id=project_id, limit=50)
            ]
            if project_id
            else []
        )
        return handoff_snapshot.handoff_gaps_and_actions(
            coverage=coverage,
            delivery_report=delivery_report,
            dispatch_sessions=dispatch_sessions,
            manual_actions=self.deps.manual_studio_actions,
        )

    async def studio_handoff_snapshot(
        self,
        project_id: str | None = None,
        source_segment_id: str | None = None,
    ) -> dict[str, Any]:
        project = self.deps.get_project(project_id) if project_id else None
        if project_id and not project:
            raise StudioDeliveryError(404, "Project not found")

        health = await self.deps.runtime_health(self._store_path())
        readiness = await self.studio_readiness()
        overview = self.studio_overview(limit=50)
        dispatch_matrix = self.dispatch_matrix(project_id=project_id, source_segment_id=source_segment_id)
        coverage = self.studio_coverage(project_id=project_id, source_segment_id=source_segment_id)
        delivery_report = self.deps.project_delivery_report(project) if project else None
        gaps, actions = self.handoff_gaps_and_actions(coverage, delivery_report, project_id=project_id)
        return handoff_snapshot.handoff_snapshot_response(
            checked_at=self.deps.now_iso(),
            project=project,
            health=health,
            readiness=readiness,
            overview=overview,
            dispatch_matrix=dispatch_matrix,
            coverage=coverage,
            delivery_report=delivery_report,
            gaps=gaps,
            actions=actions,
        )

    async def studio_readiness(self) -> dict[str, Any]:
        health = await self.deps.runtime_health(self._store_path())
        components = health.get("components") or {}
        pages = self.deps.list_pages()
        agents = self.deps.list_agents()
        route_coverage = dispatch_rules.frontend_route_coverage(
            pages,
            source_path=self.deps.frontend_route_source_path(),
            ignored_exact=self.deps.ignored_frontend_route_exact,
            ignored_prefixes=self.deps.ignored_frontend_route_prefixes,
        )
        gates = handoff_readiness.base_readiness_gates(
            components=components,
            pages=pages,
            agents=agents,
            route_coverage=route_coverage,
            core_page_ids=self.deps.core_delivery_page_ids,
            core_agent_ids=self.deps.core_delivery_agent_ids,
            storage_path=self._store_path(),
        )

        try:
            preview = await self.dispatch_preview(
                message="open my generated library",
                action="generate",
                page_id="library",
            )
            gates.append(handoff_readiness.dispatch_preview_gate(preview))
        except Exception as exc:
            gates.append(handoff_readiness.dispatch_preview_gate(error=exc))

        try:
            overview = self.studio_overview(limit=10)
            gates.append(handoff_readiness.overview_gate(overview, core_page_count=len(self.deps.core_delivery_page_ids)))
        except Exception as exc:
            gates.append(handoff_readiness.overview_gate(core_page_count=len(self.deps.core_delivery_page_ids), error=exc))

        art_auth = self.deps.adapter_auth_status("myshell-art")
        gates.append(handoff_readiness.adapter_auth_gate(art_auth))

        try:
            sample_jobs = self.deps.store.list_jobs(limit=1)
            gates.append(handoff_readiness.job_store_gate(sample_size=len(sample_jobs), storage_path=self._store_path()))
        except Exception as exc:
            gates.append(handoff_readiness.job_store_gate(storage_path=self._store_path(), error=exc))

        return handoff_readiness.readiness_response(
            gates=gates,
            health=health,
            checked_at=self.deps.now_iso(),
        )

    def delivery_audit_actions(
        self,
        requirements: list[dict[str, Any]],
        handoff: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        return handoff_audit.delivery_audit_actions(
            requirements,
            handoff,
            manual_actions=self.deps.manual_studio_actions,
        )

    async def studio_delivery_audit(
        self,
        project_id: str | None = None,
        source_segment_id: str | None = None,
    ) -> dict[str, Any]:
        project = self.deps.get_project(project_id) if project_id else None
        resolved_project_id = project.get("projectId") if project else project_id
        readiness = await self.studio_readiness()
        overview = self.studio_overview(limit=25)
        dispatch_matrix = self.dispatch_matrix(project_id=resolved_project_id, source_segment_id=source_segment_id)
        coverage = self.studio_coverage(project_id=resolved_project_id, source_segment_id=source_segment_id)
        delivery_report = self.deps.project_delivery_report(project) if project else None
        handoff = (
            await self.studio_handoff_snapshot(project_id=resolved_project_id, source_segment_id=source_segment_id)
            if project
            else None
        )
        generation_prerequisites = ((readiness.get("health") or {}).get("components") or {}).get("liveGeneration") or {}
        generation_smoke = self.deps.generation_smoke_summary(
            prerequisites=generation_prerequisites,
            latest_job=self.deps.latest_generation_smoke_job(),
        )

        pages = self.deps.list_pages()
        agents = self.deps.list_agents()
        requirements = handoff_audit.delivery_audit_requirements(
            readiness=readiness,
            dispatch_matrix=dispatch_matrix,
            generation_smoke=generation_smoke,
            generation_prerequisites=generation_prerequisites,
            handoff=handoff,
            project=project,
            core_page_count=len(self.deps.core_delivery_page_ids),
            ready_statuses=self.deps.ready_gate_statuses,
        )

        artifacts = handoff_artifacts.delivery_audit_artifacts(
            project.get("projectId") if project else None,
            dispatch_matrix.get("sourceSegmentId"),
        )
        actions = self.delivery_audit_actions(requirements, handoff)
        return handoff_audit.delivery_audit_response(
            checked_at=self.deps.now_iso(),
            project=project,
            dispatch_matrix=dispatch_matrix,
            readiness=readiness,
            overview=overview,
            coverage=coverage,
            delivery_report=delivery_report,
            handoff=handoff,
            generation_smoke=generation_smoke,
            pages=pages,
            agents=agents,
            core_page_ids=self.deps.core_delivery_page_ids,
            core_agent_ids=self.deps.core_delivery_agent_ids,
            requirements=requirements,
            artifacts=artifacts,
            actions=actions,
        )
