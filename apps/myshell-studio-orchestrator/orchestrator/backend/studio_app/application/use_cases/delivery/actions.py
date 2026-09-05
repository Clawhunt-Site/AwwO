from __future__ import annotations

from typing import Any

from studio_app.application.policies.handoff import actions as handoff_actions

from .errors import StudioDeliveryError


class StudioDeliveryActionMixin:

    async def resolve_studio_action(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        body = payload or {}
        action = str(body.get("action") or "").strip()
        target_id = str(body.get("target_id") or body.get("targetId") or "").strip()
        session_id = str(body.get("session_id") or body.get("sessionId") or "").strip()
        project_id = body.get("project_id") or body.get("projectId")
        source_segment_id = body.get("source_segment_id") or body.get("sourceSegmentId")
        if not action:
            raise StudioDeliveryError(400, "action is required")
        if not target_id:
            raise StudioDeliveryError(400, "target_id is required")

        if action == "verify-ready":
            result = self.verify_studio_coverage(
                project_id=project_id,
                source_segment_id=source_segment_id,
                page_ids=[target_id],
                limit=1,
            )
            audit = await self.studio_delivery_audit(
                project_id=result.get("projectId") or project_id,
                source_segment_id=result.get("sourceSegmentId") or source_segment_id,
            )
            return handoff_actions.coverage_verify_action_resolution(
                checked_at=self.deps.now_iso(),
                action=action,
                target_id=target_id,
                project_id=project_id,
                source_segment_id=source_segment_id,
                result=result,
                audit=audit,
            )

        if action == "run-target":
            if not session_id:
                raise StudioDeliveryError(400, "session_id is required for run-target")
            result = self.run_dispatch_session_target(session_id, target_id)
            resolved_session = result.get("session") if isinstance(result.get("session"), dict) else {}
            resolved_project_id = resolved_session.get("projectId") or project_id
            resolved_source_segment_id = resolved_session.get("sourceSegmentId") or source_segment_id
            audit = await self.studio_delivery_audit(
                project_id=resolved_project_id,
                source_segment_id=resolved_source_segment_id,
            )
            return handoff_actions.dispatch_target_run_action_resolution(
                checked_at=self.deps.now_iso(),
                action=action,
                target_id=target_id,
                session_id=session_id,
                project_id=resolved_project_id,
                source_segment_id=resolved_source_segment_id,
                result=result,
                audit=audit,
            )

        if action == "retry-queue":
            if not session_id:
                raise StudioDeliveryError(400, "session_id is required for retry-queue")
            session = self.retry_dispatch_session(session_id)
            resolved_project_id = session.get("projectId") or project_id
            resolved_source_segment_id = session.get("sourceSegmentId") or source_segment_id
            audit = await self.studio_delivery_audit(
                project_id=resolved_project_id,
                source_segment_id=resolved_source_segment_id,
            )
            return handoff_actions.dispatch_session_retry_action_resolution(
                checked_at=self.deps.now_iso(),
                action=action,
                target_id=target_id,
                session_id=session_id,
                project_id=resolved_project_id,
                source_segment_id=resolved_source_segment_id,
                session=session,
                audit=audit,
            )

        if action in self.deps.manual_studio_actions:
            audit = await self.studio_delivery_audit(project_id=project_id, source_segment_id=source_segment_id)
            return {
                **handoff_actions.manual_action_resolution(
                    action,
                    target_id,
                    session_id=session_id or None,
                ),
                "checkedAt": self.deps.now_iso(),
                "projectId": project_id,
                "sourceSegmentId": source_segment_id,
                "audit": audit,
            }

        raise StudioDeliveryError(400, f"Unsupported Studio action: {action}")

    async def resolve_studio_actions_batch(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        body = payload or {}
        project_id = body.get("project_id") or body.get("projectId")
        source_segment_id = body.get("source_segment_id") or body.get("sourceSegmentId")
        requested_actions = body.get("actions")
        if requested_actions is None:
            audit = await self.studio_delivery_audit(project_id=project_id, source_segment_id=source_segment_id)
            requested_actions = audit.get("actions") or []
        if not isinstance(requested_actions, list):
            raise StudioDeliveryError(400, "actions must be a list")

        normalized_actions: list[dict[str, Any]] = []
        for item in requested_actions:
            if not isinstance(item, dict):
                raise StudioDeliveryError(400, "Each action must be an object")
            action = str(item.get("action") or "").strip()
            target_id = str(item.get("target_id") or item.get("targetId") or "").strip()
            session_id = str(item.get("session_id") or item.get("sessionId") or "").strip()
            if not action or not target_id:
                raise StudioDeliveryError(400, "Each action requires action and target_id")
            normalized_actions.append({"action": action, "targetId": target_id, "sessionId": session_id, "raw": item})

        action_plan = handoff_actions.classify_action_batch(
            normalized_actions,
            manual_actions=self.deps.manual_studio_actions,
        )
        verify_page_ids = action_plan["verifyPageIds"]
        run_target_actions = action_plan["runTargetActions"]
        retry_queue_actions = action_plan["retryQueueActions"]
        manual_actions = action_plan["manualActions"]
        skipped_actions = action_plan["skippedActions"]

        coverage_result: dict[str, Any] | None = None
        executed_actions: list[dict[str, Any]] = []
        if verify_page_ids:
            coverage_result = self.verify_studio_coverage(
                project_id=project_id,
                source_segment_id=source_segment_id,
                page_ids=verify_page_ids,
                limit=len(verify_page_ids),
            )
            coverage_executed, coverage_skipped = handoff_actions.coverage_verify_batch_actions(verify_page_ids, coverage_result)
            executed_actions.extend(coverage_executed)
            skipped_actions.extend(coverage_skipped)

        resolved_project_id = (coverage_result or {}).get("projectId") or project_id
        resolved_source_segment_id = (coverage_result or {}).get("sourceSegmentId") or source_segment_id
        run_target_job_count = 0
        for item in run_target_actions:
            target_id = item["targetId"]
            session_id = item["sessionId"]
            try:
                result = self.run_dispatch_session_target(session_id, target_id)
            except StudioDeliveryError as exc:
                skipped_actions.append(
                    handoff_actions.action_http_skip(
                        action="run-target",
                        target_id=target_id,
                        session_id=session_id,
                        result_type="dispatch-target-run",
                        status_code=exc.status_code,
                        detail=exc.detail,
                    )
                )
                continue
            result_session = result.get("session") if isinstance(result.get("session"), dict) else {}
            resolved_project_id = result_session.get("projectId") or resolved_project_id
            resolved_source_segment_id = result_session.get("sourceSegmentId") or resolved_source_segment_id
            if result.get("job"):
                run_target_job_count += 1
            executed_actions.append(
                handoff_actions.dispatch_target_run_batch_action(
                    target_id=target_id,
                    session_id=session_id,
                    result=result,
                )
            )

        for item in retry_queue_actions:
            target_id = item["targetId"]
            session_id = item["sessionId"]
            try:
                session = self.retry_dispatch_session(session_id)
            except StudioDeliveryError as exc:
                skipped_actions.append(
                    handoff_actions.action_http_skip(
                        action="retry-queue",
                        target_id=target_id,
                        session_id=session_id,
                        result_type="dispatch-session-retry",
                        status_code=exc.status_code,
                        detail=exc.detail,
                    )
                )
                continue
            resolved_project_id = session.get("projectId") or resolved_project_id
            resolved_source_segment_id = session.get("sourceSegmentId") or resolved_source_segment_id
            executed_actions.append(
                handoff_actions.dispatch_session_retry_batch_action(
                    target_id=target_id,
                    session_id=session_id,
                    session=session,
                )
            )

        audit = await self.studio_delivery_audit(project_id=resolved_project_id, source_segment_id=resolved_source_segment_id)
        return handoff_actions.action_batch_response(
            checked_at=self.deps.now_iso(),
            requested_count=len(normalized_actions),
            project_id=resolved_project_id,
            source_segment_id=resolved_source_segment_id,
            executed_actions=executed_actions,
            manual_actions=manual_actions,
            skipped_actions=skipped_actions,
            created_jobs=int((coverage_result or {}).get("createdCount") or 0) + run_target_job_count,
            result=coverage_result,
            audit=audit,
        )
