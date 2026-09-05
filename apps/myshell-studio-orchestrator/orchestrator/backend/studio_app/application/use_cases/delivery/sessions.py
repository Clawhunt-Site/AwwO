from __future__ import annotations

from typing import Any

from studio_app.application.state import dispatch_session as dispatch_session_rules

from .errors import StudioDeliveryError


class StudioDeliverySessionMixin:

    def dispatch_session_view(self, session: dict[str, Any]) -> dict[str, Any]:
        return dispatch_session_rules.session_view(session)

    async def create_dispatch_session(
        self,
        *,
        project_id: str | None = None,
        source_segment_id: str | None = None,
        page_ids: list[str] | None = None,
        limit: int = 50,
        exclude_covered: bool = False,
    ) -> dict[str, Any]:
        plan = await self.studio_dispatch_batch_plan(
            project_id=project_id,
            source_segment_id=source_segment_id,
            page_ids=page_ids,
            limit=limit,
            exclude_covered=exclude_covered,
        )
        now = self.deps.now_iso()
        targets = [{**target, "status": "pending", "evidence": {}} for target in plan.get("targets", [])]
        session = {
            "sessionId": self.deps.make_id("dispatch_session"),
            "status": "active" if targets else "blocked",
            "createdAt": now,
            "updatedAt": now,
            "checkedAt": plan.get("checkedAt") or now,
            "projectId": plan.get("projectId"),
            "sourceSegmentId": plan.get("sourceSegmentId"),
            "sourceMediaUrl": plan.get("sourceMediaUrl", ""),
            "excludeCovered": bool(plan.get("excludeCovered")),
            "summary": plan.get("summary") or {},
            "targets": targets,
            "skippedTargets": plan.get("skippedTargets") or [],
            "matrix": plan.get("matrix") or {},
            "handoffSnapshot": plan.get("handoffSnapshot") or {},
            "planStatus": plan.get("status"),
        }
        view = self.dispatch_session_view(session)
        self.deps.store.save_dispatch_session(view)
        return view

    def get_dispatch_session_or_404(self, session_id: str) -> dict[str, Any]:
        session = self.deps.store.get_dispatch_session(session_id)
        if not session:
            raise StudioDeliveryError(404, "Dispatch session not found")
        return self.dispatch_session_view(session)

    def dispatch_session_with_focused_target(
        self,
        session: dict[str, Any],
        target_id: str | None = None,
    ) -> dict[str, Any]:
        return dispatch_session_rules.with_focused_target(session, target_id)

    def record_dispatch_session_target_completion(
        self,
        session: dict[str, Any],
        target: dict[str, Any],
        operator_evidence: dict[str, Any],
    ) -> dict[str, Any] | None:
        if target.get("executor") != "navigation":
            return None
        if target.get("evidenceJobId"):
            existing_job = self.deps.job_with_evidence(self.deps.store.get_job(str(target["evidenceJobId"])))
            dispatch_session_rules.attach_existing_evidence_job(target, existing_job)
            return existing_job

        project_id = target.get("projectId") or session.get("projectId")
        project = self.deps.get_project(str(project_id)) if project_id else None
        if not project:
            return None

        source_segment_id = target.get("sourceSegmentId") or session.get("sourceSegmentId")
        source_segment = self.deps.resolve_source_segment(project, str(source_segment_id) if source_segment_id else None)
        resolved_source_segment_id = source_segment.get("id") if source_segment else source_segment_id
        job = self.verify_navigation_page(
            project,
            dispatch_session_rules.completion_coverage_page(target),
            source_segment,
            str(resolved_source_segment_id) if resolved_source_segment_id else None,
            evidence_patch=dispatch_session_rules.completion_evidence_patch(session, target, operator_evidence),
            message=dispatch_session_rules.completion_message(target),
        )
        dispatch_session_rules.attach_completion_job(target, job)
        return job

    def update_dispatch_session_target(
        self,
        session_id: str,
        target_id: str,
        *,
        status: str,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if status not in self.deps.valid_dispatch_target_statuses:
            raise StudioDeliveryError(400, "Invalid dispatch target status")
        session = self.deps.store.get_dispatch_session(session_id)
        if not session:
            raise StudioDeliveryError(404, "Dispatch session not found")

        target = next((entry for entry in session.get("targets", []) if entry.get("id") == target_id), None)
        if not target:
            raise StudioDeliveryError(404, "Dispatch target not found")

        now = self.deps.now_iso()
        dispatch_session_rules.apply_target_status(target, status=status, now=now, evidence=evidence)
        if status == "completed":
            operator_evidence = target.get("evidence") if isinstance(target.get("evidence"), dict) else {}
            self.record_dispatch_session_target_completion(session, target, operator_evidence)

        session["updatedAt"] = now
        view = self.dispatch_session_view(session)
        self.deps.store.save_dispatch_session(view)
        return view

    def run_dispatch_session_target(self, session_id: str, target_id: str) -> dict[str, Any]:
        session = self.deps.store.get_dispatch_session(session_id)
        if not session:
            raise StudioDeliveryError(404, "Dispatch session not found")

        target = next((entry for entry in session.get("targets", []) if entry.get("id") == target_id), None)
        if not target:
            raise StudioDeliveryError(404, "Dispatch target not found")

        target_status = str(target.get("status") or "pending")
        if target_status not in {"pending", "visited"}:
            raise StudioDeliveryError(409, f"Dispatch target cannot run from status {target_status}")

        page = self.deps.get_page(str(target.get("pageId") or ""))
        project_id = target.get("projectId") or session.get("projectId")
        if not project_id:
            project = self.deps.project(None, "player")
            project_id = project["projectId"]
            session["projectId"] = project_id
            target["projectId"] = project_id
        else:
            project = self.deps.get_project(str(project_id))
            if not project:
                raise StudioDeliveryError(404, "Project not found")

        source_segment_id = target.get("sourceSegmentId") or session.get("sourceSegmentId")
        source_segment = self.deps.resolve_source_segment(project, str(source_segment_id) if source_segment_id else None)
        resolved_source_segment_id = source_segment.get("id") if source_segment else source_segment_id
        now = self.deps.now_iso()

        if page.get("executor") == "navigation":
            target_path = dispatch_session_rules.mark_navigation_target_visited(
                target,
                session_id=session_id,
                target_id=target_id,
                page=page,
                now=now,
            )
            session["updatedAt"] = now
            view = self.dispatch_session_view(session)
            self.deps.store.save_dispatch_session(view)
            return {
                "status": "navigation_required",
                "checkedAt": now,
                "session": self.dispatch_session_with_focused_target(view, target_id),
                "target": dispatch_session_rules.target_from_view(view, target_id),
                "navigationPath": target_path,
            }

        route = self.default_dispatch_route(
            source_segment_id=str(resolved_source_segment_id) if resolved_source_segment_id else None,
            source_segment=source_segment,
        )
        route.update(
            {
                "page": page,
                "api": page["id"],
                "executor": page["executor"],
                "agentId": target.get("agentId") or self.agent_id_for_page(page),
                "analysis": "Dispatch session target materialized into an executable adapter request.",
                "reason": "Operator ran a queued Studio dispatch target.",
                "optimizedPrompt": f"Dispatch {page['name']} from Studio queue.",
            }
        )
        prompt = str(route.get("optimizedPrompt") or f"Dispatch {page['name']}")
        segment = self.deps.append_queued_segment(
            project,
            route,
            prompt,
            "generate",
            str(resolved_source_segment_id) if resolved_source_segment_id else None,
        )
        job = self.deps.create_job(project, segment, route, page, source_segment, agent_id=str(route.get("agentId") or ""))
        evidence = dispatch_session_rules.job_evidence_for_target(job, session_id=session_id, target_id=target_id, page=page)
        segment["evidence"] = evidence
        segment["updatedAt"] = now
        job = self.deps.update_job(job, evidence=evidence, authStatus=self.deps.adapter_auth_status(page["id"]))
        self.deps.set_graph_status(project, route, segment)
        self.deps.append_message(
            project,
            "assistant",
            f"Queued {page['name']} dispatch target.",
            route=route,
            segmentId=segment["id"],
            jobId=job["jobId"],
        )

        dispatch_session_rules.mark_execution_target_visited(
            target,
            session_id=session_id,
            target_id=target_id,
            job=job,
            segment=segment,
            now=now,
        )
        session["updatedAt"] = now
        view = self.dispatch_session_view(session)
        self.deps.store.save_dispatch_session(view)
        self.deps.save_project(project)
        self.deps.sync_project_jobs(project)

        return {
            "status": "execution_required",
            "checkedAt": now,
            "session": self.dispatch_session_with_focused_target(view, target_id),
            "target": dispatch_session_rules.target_from_view(view, target_id),
            "job": self.deps.job_with_evidence(job),
            "project": project,
            "executionRequest": self.deps.build_execution_request(project, job),
        }

    def cancel_dispatch_session(self, session_id: str) -> dict[str, Any]:
        session = self.deps.store.get_dispatch_session(session_id)
        if not session:
            raise StudioDeliveryError(404, "Dispatch session not found")

        now = self.deps.now_iso()
        dispatch_session_rules.cancel_session_targets(session, now=now)
        view = self.dispatch_session_view(session)
        self.deps.store.save_dispatch_session(view)
        return view

    def retry_dispatch_session(self, session_id: str) -> dict[str, Any]:
        session = self.deps.store.get_dispatch_session(session_id)
        if not session:
            raise StudioDeliveryError(404, "Dispatch session not found")

        now = self.deps.now_iso()
        reopened = dispatch_session_rules.retry_session_targets(session, now=now)

        if reopened == 0:
            raise StudioDeliveryError(409, "Dispatch session has no cancelled or error targets to retry")
        view = self.dispatch_session_view(session)
        self.deps.store.save_dispatch_session(view)
        return view
