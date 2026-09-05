from __future__ import annotations

from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules

from .errors import StudioDeliveryError


class StudioDeliveryCoverageMixin:

    def dispatch_matrix_entry(
        self,
        page: dict[str, Any],
        route: dict[str, Any],
        source_segment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        runtime_page = self.page_with_runtime_status(page)
        contract = dispatch_rules.navigation_contract(page, route, source_segment)
        navigation_path = contract.get("navigationPath", "")
        missing_params = dispatch_rules.missing_route_params(page, navigation_path)
        dispatch_ready = bool(runtime_page["dispatchReady"]) and not missing_params
        dispatch_status = "missing_params" if missing_params else runtime_page["dispatchStatus"]
        return {
            "pageId": page["id"],
            "pageName": page["name"],
            "kind": page.get("kind", ""),
            "executor": runtime_page.get("executor", page.get("executor", "")),
            "agentId": self.agent_id_for_page(page),
            "recommendedAction": dispatch_rules.recommended_action_for_page(runtime_page),
            "dispatchReady": dispatch_ready,
            "dispatchStatus": dispatch_status,
            "dispatchMessage": "Missing route parameters: " + ", ".join(missing_params)
            if missing_params
            else runtime_page.get("dispatchMessage", ""),
            "authStatus": runtime_page["authStatus"],
            "clientAction": contract.get("clientAction"),
            "navigationPath": navigation_path,
            "studioReturnPath": contract.get("studioReturnPath"),
            "routeParams": page.get("routeParams") or [],
            "missingRouteParams": missing_params,
            "capabilities": page.get("capabilities") or [],
            "registrySource": page.get("registrySource", ""),
        }

    def dispatch_matrix(self, project_id: str | None = None, source_segment_id: str | None = None) -> dict[str, Any]:
        default_bot = self.deps.get_default_bot()
        project = self.deps.get_project(project_id) if project_id else None
        resolved_source_segment_id = source_segment_id or (project or {}).get("selectedSegmentId")
        source_segment = self.deps.resolve_source_segment(project, resolved_source_segment_id)
        route = {
            "bot": {
                "slug": default_bot["slug"],
                "name": default_bot["name"],
                "type": default_bot["type"],
                "rating": default_bot.get("rating", 4.5),
                "description": default_bot.get("desc", ""),
                "pageUrl": f"https://art.myshell.ai/creative/{default_bot['slug']}",
            }
        }
        entries = [self.dispatch_matrix_entry(page, route, source_segment) for page in self.deps.list_pages()]
        summary = {
            "total": len(entries),
            "ready": sum(1 for entry in entries if entry["dispatchReady"]),
            "blocked": sum(1 for entry in entries if entry["dispatchStatus"] in {"auth_missing", "error"}),
            "missingParams": sum(1 for entry in entries if entry["missingRouteParams"]),
            "navigation": sum(1 for entry in entries if entry["executor"] == "navigation"),
            "client": sum(1 for entry in entries if entry["executor"] == "client"),
            "server": sum(1 for entry in entries if entry["executor"] == "server"),
        }
        return {
            "checkedAt": self.deps.now_iso(),
            "projectId": project.get("projectId") if project else None,
            "sourceSegmentId": source_segment.get("id") if source_segment else None,
            "sourceMediaUrl": dispatch_rules.accepted_source_media_url(source_segment),
            "summary": summary,
            "entries": entries,
        }

    def coverage_status(
        self,
        entry: dict[str, Any],
        page_jobs: list[dict[str, Any]],
        accepted_count: int,
    ) -> str:
        return dispatch_rules.coverage_status(
            entry,
            page_jobs,
            accepted_count,
            pending_statuses=self.deps.pending_delivery_statuses,
            issue_statuses=self.deps.issue_delivery_statuses,
        )

    def studio_coverage(self, project_id: str | None = None, source_segment_id: str | None = None) -> dict[str, Any]:
        matrix = self.dispatch_matrix(project_id=project_id, source_segment_id=source_segment_id)
        project = self.deps.get_project(project_id) if project_id else None
        jobs = (
            self.deps.store.list_jobs(project_id=project_id, limit=500)
            if project_id
            else self.deps.store.list_jobs(limit=500)
        )

        pages: list[dict[str, Any]] = []
        statuses: list[str] = []
        accepted_total = 0
        issue_total = 0
        pending_total = 0

        for entry in matrix["entries"]:
            page_jobs = [job for job in jobs if job.get("pageId") == entry["pageId"] or job.get("api") == entry["pageId"]]
            enriched_jobs = [self.deps.job_with_evidence(job) for job in page_jobs]
            latest_job = enriched_jobs[0] if enriched_jobs else None
            accepted_evidence = [
                evidence
                for job in enriched_jobs
                for evidence in (job or {}).get("evidenceTrail", [])
                if evidence.get("accepted")
            ]
            accepted_count = len(accepted_evidence)
            latest_evidence = (latest_job or {}).get("evidence") or (accepted_evidence[0] if accepted_evidence else {})
            status = self.coverage_status(entry, page_jobs, accepted_count)
            statuses.append(status)
            accepted_total += accepted_count
            issue_total += sum(1 for job in page_jobs if str(job.get("status") or "") in self.deps.issue_delivery_statuses)
            pending_total += sum(1 for job in page_jobs if str(job.get("status") or "") in self.deps.pending_delivery_statuses)

            pages.append(
                {
                    **entry,
                    "coverageStatus": status,
                    "jobCount": len(page_jobs),
                    "acceptedEvidence": accepted_count,
                    "latestJob": latest_job,
                    "latestEvidence": latest_evidence,
                }
            )

        summary = {
            **matrix["summary"],
            "covered": statuses.count("covered"),
            "pending": statuses.count("pending"),
            "readyUnverified": statuses.count("ready_unverified"),
            "acceptedEvidence": accepted_total,
            "issues": issue_total,
            "pendingJobs": pending_total,
            "withJobs": sum(1 for page in pages if page["jobCount"]),
        }
        return {
            "status": dispatch_rules.coverage_status_summary(statuses),
            "checkedAt": self.deps.now_iso(),
            "projectId": project.get("projectId") if project else None,
            "sourceSegmentId": matrix.get("sourceSegmentId"),
            "sourceMediaUrl": matrix.get("sourceMediaUrl", ""),
            "summary": summary,
            "pages": pages,
        }

    def default_dispatch_route(
        self,
        *,
        action: str = "generate",
        source_segment_id: str | None = None,
        source_segment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return dispatch_rules.default_dispatch_route(
            self.deps.get_default_bot(),
            action=self.deps.normalize_action(action),
            source_segment_id=source_segment_id,
            source_media_url=dispatch_rules.accepted_source_media_url(source_segment),
        )

    def verify_navigation_page(
        self,
        project: dict[str, Any],
        coverage_page: dict[str, Any],
        source_segment: dict[str, Any] | None,
        resolved_source_segment_id: str | None,
        evidence_patch: dict[str, Any] | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        page = self.deps.get_page(coverage_page["pageId"])
        prompt = f"Verify {page['name']} dispatch coverage."
        route = self.default_dispatch_route(source_segment_id=resolved_source_segment_id, source_segment=source_segment)
        route["optimizedPrompt"] = prompt
        contract = dispatch_rules.navigation_contract(page, route, source_segment)
        navigation_path = contract.get("navigationPath", "")
        missing_route_params = dispatch_rules.missing_route_params(page, navigation_path)
        route = dispatch_rules.enrich_dispatch_route(
            route,
            page,
            action="generate",
            source_segment_id=resolved_source_segment_id,
            agent_id=coverage_page.get("agentId") or self.agent_id_for_page(page),
            contract=contract,
            missing_route_params=missing_route_params,
        )

        segment = self.deps.append_queued_segment(project, route, prompt, "generate", resolved_source_segment_id)
        job = self.deps.create_job(project, segment, route, page, source_segment, agent_id=route["agentId"])
        segment["status"] = "done"
        segment["evidence"] = dispatch_rules.navigation_evidence_payload(
            self.deps.evidence(
                "done",
                page["id"],
                accepted=True,
                message=message or f"Coverage verification prepared navigation dispatch for {page['name']} at {navigation_path}.",
            ),
            page=page,
            agent_id=job["agentId"],
            navigation_path=navigation_path,
            missing_route_params=[],
            coverage_verification=True,
            extra=evidence_patch,
        )
        segment["updatedAt"] = self.deps.now_iso()
        self.deps.update_job(
            job,
            status="done",
            evidence=segment["evidence"],
            authStatus=self.deps.adapter_auth_status(page["id"]),
        )
        self.deps.set_graph_status(project, route, segment)
        self.deps.append_message(
            project,
            "assistant",
            f"Verified {page['name']} navigation dispatch.",
            route=route,
            segmentId=segment["id"],
            jobId=job["jobId"],
        )
        self.deps.save_project(project)
        self.deps.sync_project_jobs(project)
        return self.deps.job_with_evidence(self.deps.store.get_job(job["jobId"])) or job

    def verify_studio_coverage(
        self,
        *,
        project_id: str | None = None,
        source_segment_id: str | None = None,
        page_ids: list[str] | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        project = self.deps.project(project_id, "player")
        before = self.studio_coverage(project_id=project["projectId"], source_segment_id=source_segment_id)
        resolved_source_segment_id = before.get("sourceSegmentId") or source_segment_id
        source_segment = self.deps.resolve_source_segment(project, resolved_source_segment_id)
        requested_page_ids = {page_id for page_id in (page_ids or []) if page_id}
        created_jobs: list[dict[str, Any]] = []
        skipped_pages: list[dict[str, Any]] = []

        for page in before["pages"]:
            if requested_page_ids and page["pageId"] not in requested_page_ids:
                continue
            if len(created_jobs) >= max(1, limit):
                skipped_pages.append(dispatch_rules.coverage_skip(page, "limit_reached", "Verification limit reached."))
                continue
            if page.get("coverageStatus") == "covered":
                skipped_pages.append(dispatch_rules.coverage_skip(page, "already_covered", "Accepted evidence already exists."))
                continue
            if page.get("missingRouteParams"):
                skipped_pages.append(dispatch_rules.coverage_skip(page, "missing_params"))
                continue
            if not page.get("dispatchReady"):
                skipped_pages.append(dispatch_rules.coverage_skip(page, "not_ready"))
                continue
            if page.get("executor") != "navigation":
                skipped_pages.append(
                    dispatch_rules.coverage_skip(
                        page,
                        "executor_not_batch_safe",
                        "Only navigation targets are automatically verified in batch.",
                    )
                )
                continue
            created_jobs.append(
                self.verify_navigation_page(
                    project,
                    page,
                    source_segment,
                    resolved_source_segment_id,
                )
            )

        self.deps.sync_project_jobs(project)
        after = self.studio_coverage(project_id=project["projectId"], source_segment_id=resolved_source_segment_id)
        return {
            "status": "verified" if created_jobs else "no_verifiable_pages",
            "checkedAt": self.deps.now_iso(),
            "project": project,
            "projectId": project["projectId"],
            "sourceSegmentId": after.get("sourceSegmentId"),
            "sourceMediaUrl": after.get("sourceMediaUrl", ""),
            "matchedCount": len(created_jobs) + len(skipped_pages),
            "createdCount": len(created_jobs),
            "skippedCount": len(skipped_pages),
            "jobs": created_jobs,
            "skippedPages": skipped_pages,
            "coverage": after,
        }

    async def studio_dispatch_batch_plan(
        self,
        *,
        project_id: str | None = None,
        source_segment_id: str | None = None,
        page_ids: list[str] | None = None,
        limit: int = 50,
        exclude_covered: bool = False,
    ) -> dict[str, Any]:
        if project_id and not self.deps.get_project(project_id):
            raise StudioDeliveryError(404, "Project not found")

        matrix = self.dispatch_matrix(project_id=project_id, source_segment_id=source_segment_id)
        coverage_by_page: dict[str, dict[str, Any]] = {}
        if exclude_covered:
            coverage = self.studio_coverage(
                project_id=matrix.get("projectId") or project_id,
                source_segment_id=matrix.get("sourceSegmentId") or source_segment_id,
            )
            coverage_by_page = {page["pageId"]: page for page in coverage.get("pages") or []}
        requested_page_ids = {page_id for page_id in (page_ids or []) if page_id}
        max_targets = max(1, min(limit, 100))
        selected_entries = [
            entry for entry in matrix.get("entries", []) if not requested_page_ids or entry.get("pageId") in requested_page_ids
        ]
        targets: list[dict[str, Any]] = []
        skipped_targets: list[dict[str, Any]] = []

        for entry in selected_entries:
            coverage_entry = coverage_by_page.get(str(entry.get("pageId") or ""))
            if exclude_covered and coverage_entry and coverage_entry.get("coverageStatus") == "covered":
                skipped = dispatch_rules.dispatch_skip(entry, "already_covered", "Accepted coverage evidence already exists.")
                skipped["coverageStatus"] = "covered"
                skipped["latestEvidence"] = coverage_entry.get("latestEvidence") or {}
                skipped_targets.append(skipped)
                continue
            if len(targets) >= max_targets:
                skipped_targets.append(dispatch_rules.dispatch_skip(entry, "limit_reached", "Dispatch batch limit reached."))
                continue
            if entry.get("missingRouteParams"):
                skipped_targets.append(dispatch_rules.dispatch_skip(entry, "missing_params"))
                continue
            if not entry.get("dispatchReady"):
                skipped_targets.append(dispatch_rules.dispatch_skip(entry, str(entry.get("dispatchStatus") or "not_ready")))
                continue
            targets.append(dispatch_rules.dispatch_target(entry, matrix))

        summary = dispatch_rules.dispatch_batch_summary(selected_entries, targets, skipped_targets)
        handoff = await self.studio_handoff_snapshot(
            project_id=matrix.get("projectId") or project_id,
            source_segment_id=matrix.get("sourceSegmentId") or source_segment_id,
        )
        return {
            "status": "planned" if targets else "blocked",
            "readyForDispatch": bool(targets),
            "checkedAt": self.deps.now_iso(),
            "projectId": matrix.get("projectId"),
            "sourceSegmentId": matrix.get("sourceSegmentId"),
            "sourceMediaUrl": matrix.get("sourceMediaUrl", ""),
            "excludeCovered": exclude_covered,
            "summary": summary,
            "targets": targets,
            "skippedTargets": skipped_targets,
            "matrix": matrix,
            "handoffSnapshot": handoff,
        }
